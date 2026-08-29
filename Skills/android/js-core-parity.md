# JS-core parity contract: iOS ⇄ Android, API by API

> The same `.dsx` must behave identically on both runtimes. iOS maps the JSE core to
> Foundation/CryptoKit/CommonCrypto/SecKey; this contract pins the REQUIRED Kotlin
> mapping and the known divergence traps for each API, and the conformance fixtures at
> the bottom are the acceptance test: **both runtimes must pass every fixture before a
> core API is called "ported".**

## The mapping

| JSE API | iOS (shipped) | Android (required mapping) | Divergence traps |
|---|---|---|---|
| `fetch` + Response shape | URLSession (`DSXRemoteCache.requestFull`) | OkHttp | Header case (both lowercase), `statusText` wording (cosmetic, don't assert on it), redirects-follow default |
| `Headers`/`Request`/`FormData`/`Blob` | dict shapes + hand-built multipart | same dict shapes + OkHttp `MultipartBody` | **Boundary format + part ordering** — keep insertion order; filename/content-type defaults (`blob`, `application/octet-stream`) |
| `URL` / `URLSearchParams` | URLComponents | `java.net.URI` + hand-rolled params (URI's query parsing is NOT form-aware) | **Space as `+` in params, `%20` in paths**; empty-value params (`a=`); non-ASCII percent-encoding (UTF-8 bytes both sides) |
| `encodeURIComponent` 등 | `addingPercentEncoding` with the JS unreserved set | hand-rolled over UTF-8 bytes (`URLEncoder` is form-encoding — **wrong**, it makes `+`) | The exact keep-sets: component `-_.!~*'()`, URI adds `;/?:@&=+$,#` |
| `Date` | ISO8601DateFormatter + Calendar (local getters) | `java.time.Instant`/`ZonedDateTime` | **Date-only ISO strings are UTC, date-time without zone is local** (JS quirk, both must copy it); ms precision in `toISOString` (always 3 digits) |
| `Intl.NumberFormat` | NumberFormatter | `android.icu.text.NumberFormat` (**`android.icu`, not `java.text`** — java.text lags ICU) | NBSP vs space in currency output **varies by ICU version — normalize whitespace in tests**; `useGrouping` |
| `Intl.DateTimeFormat` | DateFormatter (+ localized skeleton) | `android.icu.text.DateFormat` / `DateTimePatternGenerator` (same skeleton letters) | Skeleton letters must match (`y M d j m s EEE`); `j` (locale-preferred hour) is the trap — both use it, never `h`/`H` directly |
| `Intl.RelativeTimeFormat` | RelativeDateTimeFormatter | `android.icu.text.RelativeDateTimeFormatter` | `numeric:'auto'` ("yesterday") mapping |
| `RegExp` | NSRegularExpression (ICU) | `java.util.regex` is **NOT ICU** — close but diverges on some classes; prefer `android.icu` regex via `UnicodeSet`-safe patterns or document the java.util semantics | Flags `i m s` map; **`$1` templates**: Java uses `$1` too ✓ but escapes `\` differently; lexer heuristic must be byte-identical (it's in the shared JSE spec, not the platform) |
| `JSON` | JSONSerialization (+ sanitize) | `org.json` or kotlinx.serialization | Number formatting (`1.0` vs `1`) — both runtimes print integral doubles as integers (the JSE `string()` rule); key order is UNORDERED on both — **fixtures never assert key order** |
| `crypto.subtle` digest/HMAC/AES-GCM/CBC/CTR/KW | CryptoKit/CommonCrypto | `java.security.MessageDigest` / `javax.crypto.Mac` / `Cipher` (`AES/GCM/NoPadding`, `AES/CBC/PKCS5Padding`, `AES/CTR/NoPadding`, `AESWrap`) | **GCM output layout: ciphertext ‖ 16-byte tag** (Java's `Cipher` already appends the tag — do NOT re-append); PKCS5 == PKCS7 here; CTR counter = the full 16-byte block |
| ECDSA / ECDH / EdDSA / XDH | CryptoKit | `java.security` (`EC`, curves secp256r1/384r1/521r1; `Ed25519`/`X25519` API 33+ or BouncyCastle) | **Signature format: WebCrypto is raw `r‖s` — Java emits DER by default; convert** (the classic interop bug); public raw = X9.63 uncompressed |
| RSA (PKCS1-v1_5 / PSS / OAEP) | SecKey + minimal DER | `java.security` (`RSASSA-PSS` with `MGF1`, `RSA/ECB/OAEPWith…`) | **PSS salt length = hash length** (pin it — Java defaults can differ); OAEP hash AND MGF1 hash must both be set to the chosen hash |
| PBKDF2 / HKDF | CommonCrypto / CryptoKit | `PBKDF2WithHmacSHA256` etc. / hand-rolled or BC HKDF | Iteration + salt byte-exactness; HKDF expand info |
| `getRandomValues`/`randomUUID` | SecRandomCopyBytes / UUID | `SecureRandom` / `UUID.randomUUID()` | UUID **lowercase** on both |
| `btoa`/`atob`, `toBase64/fromBase64`, `toHex` | Foundation | `android.util.Base64` (NO_WRAP) / `java.util.Base64` | **No line wrapping**; base64url for JWK (`-_`, no padding) |
| Timers | DispatchQueue (keyed, 250ms interval floor) | Handler/Looper main (keyed, same floor) | Coalescing on background return — both "fire late, once" |
| `WebSocket` | URLSessionWebSocketTask (keyed, surface-scoped) | OkHttp WebSocket (keyed, surface-scoped) | **Lifecycle is the contract** (see `lifecycle.md`): close on store teardown, same-key replace, binary = byte arrays, close code 1006 on failure path |
| `structuredClone`/`Object.*`/`Map`/`Set`/arrays | value dicts | value maps (the Kotlin store is the same shape) | `sort` default is LEXICOGRAPHIC (JS quirk — both must copy); `Map` key equality = JSE `equals`, not reference |
| `console`/`JSETrace`/`JSERedact` | NSLog + ring buffers | Logcat + the same ring buffers | The redaction key list is part of the contract — keep the lists identical |
| `navigator.*` | Locale/NWPathMonitor | `Locale.getDefault()`/ConnectivityManager | `language` BCP-47 form (`en-US`) on both |

## Conformance fixtures

Run each snippet through JSE on both platforms; compare to `expect`. Exact-match unless
marked *(normalized)* — Intl rows strip NBSP→space before comparing; never assert JSON
key order or `statusText` wording.

| # | JSE | expect |
|---|---|---|
| C1 | `(await crypto.subtle.digest('SHA-256', 'abc')).toHex()` | `ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad` |
| C2 | `const k = await crypto.subtle.importKey('raw', 'key', { name:'HMAC', hash:'SHA-256' }, false, ['sign']); (await crypto.subtle.sign('HMAC', k, 'The quick brown fox jumps over the lazy dog')).toHex()` | `f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8` |
| C3 | AES-GCM round-trip: generate 256 → encrypt `'hi'` (12-byte iv) → decrypt → `new TextDecoder().decode(plain)` | `hi` (and sealed length = 2 + 16) |
| C4 | `btoa('hello')` · `atob('aGVsbG8=')` | `aGVsbG8=` · `hello` |
| C5 | `Uint8Array.fromHex('00ff10').toBase64()` | `AP8Q` |
| U1 | `new URL('/checkout?plan=pro', 'https://shop.example.com/x').href` | `https://shop.example.com/checkout?plan=pro` |
| U2 | same URL: `.pathname` · `.origin` · `.searchParams.get('plan')` | `/checkout` · `https://shop.example.com` · `pro` |
| U3 | `const p = new URLSearchParams(); p.set('a b', 'c+d'); p.toString()` | `a+b=c%2Bd` |
| U4 | `encodeURIComponent('a b&c=d/é')` | `a%20b%26c%3Dd%2F%C3%A9` |
| D1 | `new Date('2026-03-04T05:06:07.890Z').getTime()` then `new Date(<that ms>).toISOString()` | round-trips to `2026-03-04T05:06:07.890Z` |
| D2 | `new Date('2026-03-04').getTime()` − `Date.parse('2026-03-04T00:00:00.000Z')` | `0` (date-only ISO is UTC) |
| D3 | `isNaN(new Date('garbage').getTime())` | `true` |
| I1 | `new Intl.NumberFormat('en-US', { style:'currency', currency:'USD' }).format(9.99)` | `$9.99` *(normalized)* |
| I2 | `new Intl.NumberFormat('de-DE', { maximumFractionDigits: 1 }).format(1234.56)` | `1.234,6` *(normalized)* |
| R1 | `/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test('x@y.com')` · same for `'nope'` | `true` · `false` |
| R2 | `'a1b2c3'.replace(/\d/g, '#')` | `a#b#c#` |
| R3 | `'Slug Title! 9'.toLowerCase().replace(/[^a-z0-9]+/g, '-')` | `slug-title-9` |
| R4 | `'a, b,c'.split(/\s*,\s*/).join('|')` | `a|b|c` |
| R5 | `'/show/42'.match(/^\/show\/(\d+)$/)[1]` | `42` |
| J1 | `JSON.parse('{"a":[1,2],"b":"x"}').a[1]` | `2` |
| J2 | `JSON.stringify({ d: new Date('2026-01-01T00:00:00.000Z') })` | `{"d":"2026-01-01T00:00:00.000Z"}` |
| N1 | `parseInt('0x1F')` · `parseInt('12px')` · `parseFloat('3.5kg')` | `31` · `12` · `3.5` |
| N2 | `(255).toString(16).padStart(4, '0')` | `00ff` |
| A1 | `[3,1,2].sort().join('')` · `[3,1,10].sort().join(',')` | `123` · `1,10,3` (lexicographic default — the JS quirk) |
| A2 | `[3,1,10].sort((a,b) => a-b).join(',')` | `1,3,10` |
| A3 | `[[1,2],[3]].flat().concat(4).at(-1)` | `4` |
| A4 | `[1,2,3].map(x => x * 2).join(',')` (bare-ident arrow) · `[1,2].map(x => [10,20].map(y => x + y).join('-')).join(',')` (closure capture) | `2,4,6` · `11-21,12-22` |
| A5 | `Object.groupBy([{t:'a'},{t:'b'},{t:'a'}], x => x.t)['a'].length` · `Array.from({ length: 3 }, (_, i) => i).join(',')` | `2` · `0,1,2` |
| A6 | `'despia'.slice(-3)` · `'despia'.slice(0, -3)` · `'hello'.indexOf('ll')` · `'despia'.endsWith('ia')` | `pia` · `des` · `2` · `true` |
| E1 | `10 % 3` · `-7 % 3` · `7 % 0` | `1` · `-1` (truncating, dividend sign) · `0` (the /0 law) |
| E2 | `'a' < 'b'` · `'10' < '9'` · `'5' < 10` | `true` · `true` (string×string lexicographic) · `true` (mixed stays numeric) |
| E3 | `{ a: 1 } == { a: 1 }` · `[1,2] == [2,1]` | `true` (structural, key-order-insensitive) · `false` |
| E4 | `typeof 1` · `typeof missing` · `typeof [1]` | `number` · `undefined` (null/undefined are ONE missing value — deliberate JS divergence) · `object` |
| M1 | `const m = new Map(); m.set('a', 1); m.set('a', 2); m.size + ':' + m.get('a')` | `1:2` |
| M2 | `const s = new Set([1,1,2]); s.add(2); s.size` | `2` |
| P1 | `await Promise.all([1, fetch(<echo 200>), 'x'])` — element order | `[1, <response>, 'x']` (order preserved, concurrent) |
| W1 | socket lifecycle: open keyed `'t'`, open keyed `'t'` again | first socket closed (replaced); store teardown closes the second |

## Process

1. A core API lands on iOS with its fixtures listed here in the same PR.
2. The Android port is DONE when its runner passes the same fixture table — not before.
3. A fixture that can't be made identical gets a **documented divergence** row in the
   mapping table instead of a silently different behavior. Divergence without
   documentation is a bug, on either platform.

## Record mode — corpus authority

The permanent home of these fixtures is `OpenSource/Conformance/jse/*.json`
(`{scope, expression, expected}` triples), and its authority rule is: **Swift is the
reference — the corpus records what the Swift kernel actually does.** The Codemagic
**`conformance-record`** lane (manual trigger, never on a PR) compiles the real open kernel
standalone (`OpenSource/Engine/iOS/JSEConformanceRecord.swift` +
`ClosedSource/scripts/conformance/record_jse_conformance.sh`, iphonesimulator target, run
via `simctl spawn`), re-emits every corpus file with `expected` = the Swift kernel's actual
result — byte-identical to the committed files when behavior agrees — uploads the
regenerated corpus as an artifact, and FAILS on any drift.

The flow for a JSE change, on either platform:

1. change the Swift kernel first (or spec the behavior against it) — Kotlin never
   authoritates a triple;
2. run `conformance-record`, commit the regenerated artifact over
   `OpenSource/Conformance/jse/` (never hand-edit `expected` against the reference);
3. the Kotlin kernel must pass the new corpus before the change ships
   (`cd OpenSource/Engine/Android && gradle test` — `ConformanceTest` runs it on every PR
   via the android-kernel lane).

A red `conformance-record` run with no intended change = a Swift regression or an
over-eager corpus edit; fix the code, not the fixtures.
