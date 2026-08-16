package despia.engine

import java.util.Base64
import java.util.TimeZone
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/// Conformance tests for the JS-globals/crypto layer (Globals.kt) — behavior pinned to
/// Stack.swift's JSECore/JSECrypto sections per js-core-parity.md (fixtures C1–R4 where
/// they touch this layer; byte-exact where the contract specifies). Everything runs
/// through the PUBLIC evaluator surface (JSE.eval / the real dispatch), so these rows
/// exercise the exact routing the stubs reserved.
///
/// Timezone: tests pin America/New_York as the "local" zone (getters are LOCAL, the
/// date-only-ISO-is-UTC quirk is observable only when local ≠ UTC), restored after.
class GlobalsTest {

    private var savedTZ: TimeZone? = null

    @BeforeTest
    fun pinZone() {
        savedTZ = TimeZone.getDefault()
        TimeZone.setDefault(TimeZone.getTimeZone("America/New_York"))
    }

    @AfterTest
    fun restoreZone() {
        savedTZ?.let { TimeZone.setDefault(it) }
    }

    // ── harness ─────────────────────────────────────────────────────────────────────────

    private val store = StackStore()
    private fun ev(expr: String): Any? = JSE.eval(expr, store, null)
    private fun s(expr: String): String = JSE.string(ev(expr))
    private fun n(expr: String): Double? = JSE.number(ev(expr))
    private fun put(name: String, expr: String) { store.vars[name] = ev(expr) }

    private fun hexBytes(hex: String): List<Any?> =
        hex.chunked(2).map { it.toInt(16).toDouble() }
    private fun b64url(hex: String): String =
        Base64.getEncoder().encodeToString(hex.chunked(2).map { it.toInt(16).toByte() }.toByteArray())
            .replace("+", "-").replace("/", "_").replace("=", "")

    // ── C1–C5: crypto + companions ──────────────────────────────────────────────────────

    @Test
    fun c1_digestSha256() {   // C1 — byte-exact
        assertEquals("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
            s("crypto.subtle.digest('SHA-256', 'abc').toHex()"))
        // expression-position await is the identity, exactly like iOS
        assertEquals("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
            s("(await crypto.subtle.digest('SHA-256', 'abc')).toHex()"))
    }

    @Test
    fun digestOtherAlgorithms() {
        assertEquals("a9993e364706816aba3e25717850c26c9cd0d89d", s("crypto.subtle.digest('SHA-1', 'abc').toHex()"))
        assertEquals("cb00753f45a35e8bb5a03d699ac65007272c32ab0eded1631a8b605a43ff5bed" +
            "8086072ba1e7cc2358baeca134c825a7", s("crypto.subtle.digest('SHA-384', 'abc').toHex()"))
        assertNull(ev("crypto.subtle.digest('MD5', 'abc')"))       // unsupported → log + null (total)
    }

    @Test
    fun c2_hmacImportAndSign() {   // C2 — byte-exact
        put("k", "crypto.subtle.importKey('raw', 'key', { name:'HMAC', hash:'SHA-256' }, false, ['sign'])")
        assertEquals("f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8",
            s("crypto.subtle.sign('HMAC', k, 'The quick brown fox jumps over the lazy dog').toHex()"))
    }

    @Test
    fun hmacVerify() {
        put("k", "crypto.subtle.importKey('raw', 'key', { name:'HMAC', hash:'SHA-256' }, false, ['sign','verify'])")
        put("sig", "crypto.subtle.sign('HMAC', k, 'msg')")
        assertEquals(true, ev("crypto.subtle.verify('HMAC', k, sig, 'msg')"))
        assertEquals(false, ev("crypto.subtle.verify('HMAC', k, sig, 'other')"))
    }

    @Test
    fun c3_aesGcmRoundTrip() {   // C3 — round-trip + sealed layout (ciphertext ‖ 16-byte tag)
        put("key", "crypto.subtle.generateKey({ name:'AES-GCM', length: 256 }, true, ['encrypt','decrypt'])")
        put("iv", "crypto.getRandomValues(new Uint8Array(12))")
        put("sealed", "crypto.subtle.encrypt({ name:'AES-GCM', iv: iv }, key, 'hi')")
        assertEquals(2 + 16, (store.vars["sealed"] as List<*>).size)
        assertEquals("hi", s("new TextDecoder().decode(crypto.subtle.decrypt({ name:'AES-GCM', iv: iv }, key, sealed))"))
        // a wrong key breaks the tag → total null (nothing throws across the engine boundary)
        put("key2", "crypto.subtle.generateKey({ name:'AES-GCM', length: 256 }, true, ['decrypt'])")
        assertNull(ev("crypto.subtle.decrypt({ name:'AES-GCM', iv: iv }, key2, sealed)"))
    }

    @Test
    fun aesGcmAdditionalData() {
        put("key", "crypto.subtle.generateKey({ name:'AES-GCM' }, true, ['encrypt','decrypt'])")   // default 256
        put("iv", "crypto.getRandomValues(new Uint8Array(12))")
        put("sealed", "crypto.subtle.encrypt({ name:'AES-GCM', iv: iv, additionalData:'ctx' }, key, 'x')")
        assertEquals("x", s("new TextDecoder().decode(crypto.subtle.decrypt({ name:'AES-GCM', iv: iv, additionalData:'ctx' }, key, sealed))"))
        assertNull(ev("crypto.subtle.decrypt({ name:'AES-GCM', iv: iv, additionalData:'other' }, key, sealed)"))
        assertNull(ev("crypto.subtle.encrypt({ name:'AES-GCM', iv: iv, tagLength: 96 }, key, 'x')"))  // 128 only
    }

    @Test
    fun c4_btoaAtob() {   // C4 — byte-exact
        assertEquals("aGVsbG8=", s("btoa('hello')"))
        assertEquals("hello", s("atob('aGVsbG8=')"))
        assertNull(ev("atob('%%%')"))                              // bad base64 → log + null
    }

    @Test
    fun c5_fromHexToBase64() {   // C5 — byte-exact
        assertEquals("AP8Q", s("Uint8Array.fromHex('00ff10').toBase64()"))
        assertEquals("00ff10", s("Uint8Array.fromBase64('AP8Q').toHex()"))
        assertNull(ev("Uint8Array.fromHex('0f0')"))                // odd length → null
    }

    @Test
    fun textEncoderUint8ArrayArrayFrom() {
        assertEquals("616263", s("new TextEncoder().encode('abc').toHex()"))
        assertEquals(3.0, n("new Uint8Array(3).length"))
        assertEquals("000000", s("new Uint8Array(3).toHex()"))
        assertEquals("61,98,99", s("Array.from(new TextEncoder().encode('abc')).map((b, i) => i == 0 ? b.toString(16) : b).join(',')"))
    }

    @Test
    fun randomPrimitives() {
        val uuid = s("crypto.randomUUID()")
        assertTrue(Regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$").matches(uuid))  // lowercase
        assertEquals(16.0, n("crypto.getRandomValues(new Uint8Array(16)).length"))
        assertNull(ev("crypto.getRandomValues(new Uint8Array(0))"))       // 1…65536
    }

    // ── ECDH / ECDSA / OKP ─────────────────────────────────────────────────────────────

    @Test
    fun ecdhSharedSecret_rfc5903() {   // fixed keys — byte-exact shared secret
        store.vars["privJwk"] = linkedMapOf<String, Any?>("kty" to "EC",
            "d" to b64url("C88F01F510D9AC3F70A292DAA2316DE544E9AAB8AFE84049C62A9C57862D1433"))
        store.vars["pubRaw"] = hexBytes("04" +
            "D12DFB5289C8D4F81208B70270398C342296970A0BCCB74C736FC7554494BF63" +
            "56FBF3CA366CC23E8157854C13C58D6AAC23F046ADA30F8353E74F33039872AB")
        put("priv", "crypto.subtle.importKey('jwk', privJwk, { name:'ECDH', namedCurve:'P-256' }, false, ['deriveBits'])")
        put("pub", "crypto.subtle.importKey('raw', pubRaw, { name:'ECDH', namedCurve:'P-256' }, false, [])")
        assertNotNull(store.vars["priv"]); assertNotNull(store.vars["pub"])
        assertEquals("d6840f6b42f6edafd13116e0e12565202fef8e9ece7dce03812464d04b9442de",
            s("crypto.subtle.deriveBits({ name:'ECDH', public: pub }, priv, 256).toHex()"))
        // length prefixing
        assertEquals("d6840f6b", s("crypto.subtle.deriveBits({ name:'ECDH', public: pub }, priv, 32).toHex()"))
    }

    @Test
    fun ecdhGeneratedRoundTrip() {
        put("a", "crypto.subtle.generateKey({ name:'ECDH', namedCurve:'P-256' }, true, ['deriveBits'])")
        put("b", "crypto.subtle.generateKey({ name:'ECDH', namedCurve:'P-256' }, true, ['deriveBits'])")
        val s1 = s("crypto.subtle.deriveBits({ name:'ECDH', public: b.publicKey }, a.privateKey, 256).toHex()")
        val s2 = s("crypto.subtle.deriveBits({ name:'ECDH', public: a.publicKey }, b.privateKey, 256).toHex()")
        assertEquals(64, s1.length)
        assertEquals(s1, s2)
    }

    @Test
    fun ecdsaSignVerify() {
        put("kp", "crypto.subtle.generateKey({ name:'ECDSA', namedCurve:'P-256' }, true, ['sign','verify'])")
        put("sig", "crypto.subtle.sign({ name:'ECDSA', hash:'SHA-256' }, kp.privateKey, 'payload')")
        assertEquals(64.0, n("sig.length"))                        // raw r‖s (P1363), never DER
        assertEquals(true, ev("crypto.subtle.verify({ name:'ECDSA', hash:'SHA-256' }, kp.publicKey, sig, 'payload')"))
        assertEquals(false, ev("crypto.subtle.verify({ name:'ECDSA', hash:'SHA-256' }, kp.publicKey, sig, 'tampered')"))
        // raw public export/import round-trips (X9.63 uncompressed)
        put("pubRaw", "crypto.subtle.exportKey('raw', kp.publicKey)")
        assertEquals(65.0, n("pubRaw.length"))
        put("pub2", "crypto.subtle.importKey('raw', pubRaw, { name:'ECDSA', namedCurve:'P-256' }, true, ['verify'])")
        assertEquals(true, ev("crypto.subtle.verify({ name:'ECDSA', hash:'SHA-256' }, pub2, sig, 'payload')"))
        // jwk export of the private key carries x/y/d
        put("jwk", "crypto.subtle.exportKey('jwk', kp.privateKey)")
        assertEquals("EC", s("jwk.kty")); assertEquals("P-256", s("jwk.crv"))
        assertTrue(s("jwk.d").isNotEmpty() && s("jwk.x").isNotEmpty() && s("jwk.y").isNotEmpty())
    }

    @Test
    fun ed25519_rfc8032_vector1() {   // fixed keys — byte-exact signature
        store.vars["privJwk"] = linkedMapOf<String, Any?>("kty" to "OKP",
            "d" to b64url("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60"))
        store.vars["pubRaw"] = hexBytes("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a")
        put("priv", "crypto.subtle.importKey('jwk', privJwk, 'Ed25519', false, ['sign'])")
        put("pub", "crypto.subtle.importKey('raw', pubRaw, 'Ed25519', false, ['verify'])")
        put("sig", "crypto.subtle.sign('Ed25519', priv, '')")
        assertEquals("e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555f" +
            "b8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b", s("sig.toHex()"))
        assertEquals(true, ev("crypto.subtle.verify('Ed25519', pub, sig, '')"))
        assertEquals(false, ev("crypto.subtle.verify('Ed25519', pub, sig, 'x')"))
    }

    @Test
    fun x25519_rfc7748_vector() {   // fixed keys — byte-exact shared secret
        store.vars["privJwk"] = linkedMapOf<String, Any?>("kty" to "OKP",
            "d" to b64url("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a"))
        store.vars["pubRaw"] = hexBytes("de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f")
        put("priv", "crypto.subtle.importKey('jwk', privJwk, 'X25519', false, ['deriveBits'])")
        put("pub", "crypto.subtle.importKey('raw', pubRaw, 'X25519', false, [])")
        assertEquals("4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742",
            s("crypto.subtle.deriveBits({ name:'X25519', public: pub }, priv, 256).toHex()"))
    }

    @Test
    fun okpGenerateAndJwkRoundTrip() {
        put("kp", "crypto.subtle.generateKey('Ed25519', true, ['sign','verify'])")
        put("sig", "crypto.subtle.sign('Ed25519', kp.privateKey, 'm')")
        assertEquals(true, ev("crypto.subtle.verify('Ed25519', kp.publicKey, sig, 'm')"))
        put("jwk", "crypto.subtle.exportKey('jwk', kp.privateKey)")   // pub stashed at generate
        assertEquals("OKP", s("jwk.kty")); assertEquals("Ed25519", s("jwk.crv"))
        put("priv2", "crypto.subtle.importKey('jwk', jwk, 'Ed25519', true, ['sign'])")
        assertEquals(s("crypto.subtle.sign('Ed25519', kp.privateKey, 'm2').toHex()"),
            s("crypto.subtle.sign('Ed25519', priv2, 'm2').toHex()"))  // Ed25519 is deterministic
    }

    // ── AES-CBC / AES-CTR / AES-KW / PBKDF2 / HKDF / RSA ───────────────────────────────

    @Test
    fun aesCbcRoundTrip() {
        put("key", "crypto.subtle.generateKey({ name:'AES-CBC', length: 128 }, true, ['encrypt','decrypt'])")
        put("iv", "crypto.getRandomValues(new Uint8Array(16))")
        put("sealed", "crypto.subtle.encrypt({ name:'AES-CBC', iv: iv }, key, 'hello cbc')")
        assertEquals(16.0, n("sealed.length"))                     // PKCS7-padded to one block
        assertEquals("hello cbc", s("new TextDecoder().decode(crypto.subtle.decrypt({ name:'AES-CBC', iv: iv }, key, sealed))"))
        assertNull(ev("crypto.subtle.encrypt({ name:'AES-CBC', iv: [1,2,3] }, key, 'x')"))   // 16-byte iv required
    }

    @Test
    fun aesCtr_sp80038a_vector() {   // byte-exact (NIST SP 800-38A F.5.1)
        store.vars["rawKey"] = hexBytes("2b7e151628aed2a6abf7158809cf4f3c")
        store.vars["counter"] = hexBytes("f0f1f2f3f4f5f6f7f8f9fafbfcfdfeff")
        store.vars["plain"] = hexBytes("6bc1bee22e409f96e93d7e117393172a")
        put("key", "crypto.subtle.importKey('raw', rawKey, 'AES-CTR', false, ['encrypt','decrypt'])")
        assertEquals("874d6191b620e3261bef6864990db6ce",
            s("crypto.subtle.encrypt({ name:'AES-CTR', counter: counter, length: 64 }, key, plain).toHex()"))
    }

    @Test
    fun aesKw_rfc3394_vector() {   // byte-exact (RFC 3394 §4.1) via wrapKey/unwrapKey
        store.vars["kekRaw"] = hexBytes("000102030405060708090a0b0c0d0e0f")
        store.vars["cekRaw"] = hexBytes("00112233445566778899aabbccddeeff")
        put("kek", "crypto.subtle.importKey('raw', kekRaw, 'AES-KW', false, ['wrapKey','unwrapKey'])")
        put("cek", "crypto.subtle.importKey('raw', cekRaw, 'AES-GCM', true, ['encrypt'])")
        put("wrapped", "crypto.subtle.wrapKey('raw', cek, kek, 'AES-KW')")
        assertEquals("1fa68b0a8112b447aef34bd8fb5a7b829d3e862371d2cfe5", s("wrapped.toHex()"))
        put("cek2", "crypto.subtle.unwrapKey('raw', wrapped, kek, 'AES-KW', 'AES-GCM', true, ['encrypt'])")
        assertEquals("00112233445566778899aabbccddeeff", s("crypto.subtle.exportKey('raw', cek2).toHex()"))
    }

    @Test
    fun pbkdf2_sha256_vector() {   // byte-exact (P='password', S='salt', c=1, 32 bytes)
        put("k", "crypto.subtle.importKey('raw', 'password', 'PBKDF2', false, ['deriveBits'])")
        assertEquals("120fb6cffcf8b32c43e7225256c4f837a86548c92ccc35480805987cb70be17b",
            s("crypto.subtle.deriveBits({ name:'PBKDF2', salt:'salt', iterations: 1, hash:'SHA-256' }, k, 256).toHex()"))
        assertNull(ev("crypto.subtle.deriveBits({ name:'PBKDF2', salt:'salt', hash:'SHA-256' }, k, 256)"))  // iterations required
    }

    @Test
    fun hkdf_rfc5869_case1() {   // byte-exact (RFC 5869 A.1, SHA-256, L=42)
        store.vars["ikm"] = hexBytes("0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b")
        store.vars["salt"] = hexBytes("000102030405060708090a0b0c")
        store.vars["info"] = hexBytes("f0f1f2f3f4f5f6f7f8f9")
        put("k", "crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits'])")
        assertEquals("3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf" +
            "34007208d5b887185865",
            s("crypto.subtle.deriveBits({ name:'HKDF', salt: salt, info: info, hash:'SHA-256' }, k, 336).toHex()"))
    }

    @Test
    fun deriveKeyHmacDefaults() {   // deriveKey → importable HMAC key (block-size default length)
        put("base", "crypto.subtle.importKey('raw', 'pw', 'PBKDF2', false, ['deriveKey'])")
        put("hk", "crypto.subtle.deriveKey({ name:'PBKDF2', salt:'s', iterations: 2, hash:'SHA-256' }, base, { name:'HMAC', hash:'SHA-256' }, true, ['sign'])")
        assertEquals("secret", s("hk.type"))
        assertEquals(512.0, n("hk.algorithm.length"))              // HMAC default = hash block size
        assertEquals(32.0, n("crypto.subtle.sign('HMAC', hk, 'm').length"))   // 32-byte SHA-256 MAC
    }

    @Test
    fun rsaSignVerifyAndOaep() {
        put("kp", "crypto.subtle.generateKey({ name:'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: [1,0,1], hash:'SHA-256' }, true, ['sign','verify'])")
        put("sig", "crypto.subtle.sign('RSASSA-PKCS1-v1_5', kp.privateKey, 'doc')")
        assertEquals(256.0, n("sig.length"))
        assertEquals(true, ev("crypto.subtle.verify('RSASSA-PKCS1-v1_5', kp.publicKey, sig, 'doc')"))
        assertEquals(false, ev("crypto.subtle.verify('RSASSA-PKCS1-v1_5', kp.publicKey, sig, 'forged')"))
        assertEquals("RSASSA-PKCS1-v1_5", s("kp.publicKey.algorithm.name"))
        // jwk round trip (public)
        put("jwk", "crypto.subtle.exportKey('jwk', kp.publicKey)")
        assertEquals("RSA", s("jwk.kty"))
        assertEquals("AQAB", s("jwk.e"))                           // 65537
        put("pub2", "crypto.subtle.importKey('jwk', jwk, { name:'RSASSA-PKCS1-v1_5', hash:'SHA-256' }, true, ['verify'])")
        assertEquals(true, ev("crypto.subtle.verify('RSASSA-PKCS1-v1_5', pub2, sig, 'doc')"))
        // spki/pkcs8 round trip through the minimal DER
        put("spki", "crypto.subtle.exportKey('spki', kp.publicKey)")
        put("pub3", "crypto.subtle.importKey('spki', spki, { name:'RSASSA-PKCS1-v1_5', hash:'SHA-256' }, true, ['verify'])")
        assertEquals(true, ev("crypto.subtle.verify('RSASSA-PKCS1-v1_5', pub3, sig, 'doc')"))
        // PSS: salt length must equal hash length; OAEP round-trips
        put("pssKp", "crypto.subtle.generateKey({ name:'RSA-PSS', modulusLength: 2048, hash:'SHA-256' }, true, ['sign','verify'])")
        put("pssSig", "crypto.subtle.sign({ name:'RSA-PSS', saltLength: 32 }, pssKp.privateKey, 'doc')")
        assertEquals(true, ev("crypto.subtle.verify({ name:'RSA-PSS', saltLength: 32 }, pssKp.publicKey, pssSig, 'doc')"))
        assertNull(ev("crypto.subtle.sign({ name:'RSA-PSS', saltLength: 20 }, pssKp.privateKey, 'doc')"))
        put("oaepKp", "crypto.subtle.generateKey({ name:'RSA-OAEP', modulusLength: 2048, hash:'SHA-256' }, true, ['encrypt','decrypt'])")
        put("ct", "crypto.subtle.encrypt('RSA-OAEP', oaepKp.publicKey, 'secret')")
        assertEquals("secret", s("new TextDecoder().decode(crypto.subtle.decrypt('RSA-OAEP', oaepKp.privateKey, ct))"))
        assertNull(ev("crypto.subtle.generateKey({ name:'RSA-OAEP', publicExponent: [3] }, true, [])"))  // 65537 only
    }

    @Test
    fun exportRequiresExtractable() {
        put("k", "crypto.subtle.importKey('raw', 'key', { name:'HMAC', hash:'SHA-256' }, false, ['sign'])")
        assertNull(ev("crypto.subtle.exportKey('raw', k)"))
        put("k2", "crypto.subtle.importKey('raw', 'key', { name:'HMAC', hash:'SHA-256' }, true, ['sign'])")
        assertEquals("6b6579", s("crypto.subtle.exportKey('raw', k2).toHex()"))
        assertEquals("a2V5", s("crypto.subtle.exportKey('jwk', k2).k"))   // b64url
    }

    // ── U1–U4: URL / URLSearchParams / encoding ─────────────────────────────────────────

    @Test
    fun u1_u2_urlResolutionAndParts() {
        assertEquals("https://shop.example.com/checkout?plan=pro",
            s("new URL('/checkout?plan=pro', 'https://shop.example.com/x').href"))
        put("u", "new URL('/checkout?plan=pro', 'https://shop.example.com/x')")
        assertEquals("/checkout", s("u.pathname"))
        assertEquals("https://shop.example.com", s("u.origin"))
        assertEquals("pro", s("u.searchParams.get('plan')"))
        assertEquals("https:", s("u.protocol"))
        assertEquals("?plan=pro", s("u.search"))
        assertEquals("https://shop.example.com/checkout?plan=pro", s("'' + u"))   // string coercion → href
    }

    @Test
    fun urlEdges() {
        assertEquals("https://a.example.com/b/d", s("new URL('d', 'https://a.example.com/b/c').href"))
        assertEquals("https://a.example.com/d", s("new URL('../d', 'https://a.example.com/b/c').href"))
        assertEquals("https://a.example.com/b/c?q=1", s("new URL('?q=1', 'https://a.example.com/b/c').href"))
        assertEquals("https://other.example.com/", s("new URL('//other.example.com/', 'https://a.example.com/b').href"))
        assertEquals("8080", s("new URL('http://h.example.com:8080/p').port"))
        assertEquals("h.example.com:8080", s("new URL('http://h.example.com:8080/p').host"))
        assertEquals("http://h.example.com:8080", s("new URL('http://h.example.com:8080/p').origin"))
        assertEquals("/", s("new URL('https://a.example.com').pathname"))         // empty path → "/"
        assertEquals("#frag", s("new URL('https://a.example.com/#frag').hash"))
        assertNull(ev("new URL('ht tp://bad')"))                   // whitespace → invalid, like URL(string:)
    }

    @Test
    fun u3_searchParamsFormEncoding() {   // expression position returns the modified copy
        put("p", "new URLSearchParams()")
        put("p", "p.set('a b', 'c+d')")
        assertEquals("a+b=c%2Bd", s("p.toString()"))
        // parse is form-aware ('+' → space), append/getAll/delete
        put("q", "new URLSearchParams('x=1&x=2&y=a+b')")
        assertEquals("a b", s("q.get('y')"))
        assertEquals("1,2", s("q.getAll('x').join(',')"))
        assertEquals(true, ev("q.has('x')"))
        put("q", "q.delete('x')")
        assertEquals("y=a+b", s("q.toString()"))                   // stored decoded ("a b") → re-encodes space as '+'
    }

    @Test
    fun u4_encodeURIComponent() {   // byte-exact
        assertEquals("a%20b%26c%3Dd%2F%C3%A9", s("encodeURIComponent('a b&c=d/é')"))
        store.vars["marks"] = "-_.!~*'()"
        assertEquals("-_.!~*'()", s("encodeURIComponent(marks)"))  // the component keep-set stays raw
        assertEquals("a%20b&c=d/%C3%A9", s("encodeURI('a b&c=d/é')"))
        assertEquals("a b&c=d/é", s("decodeURIComponent('a%20b%26c%3Dd%2F%C3%A9')"))
        assertEquals("%E0%A4%A", s("decodeURIComponent('%E0%A4%A')"))   // malformed → input unchanged
    }

    // ── D1–D3: Date ─────────────────────────────────────────────────────────────────────

    @Test
    fun d1_isoRoundTrip() {
        val ms = n("new Date('2026-03-04T05:06:07.890Z').getTime()")
        assertNotNull(ms)
        store.vars["ms"] = ms
        assertEquals("2026-03-04T05:06:07.890Z", s("new Date(ms).toISOString()"))
        assertEquals("2026-03-04T05:06:07.890Z", s("'' + new Date(ms)"))          // string coercion → ISO
        assertEquals(890.0, n("new Date(ms).getMilliseconds()"))
    }

    @Test
    fun d2_dateOnlyIsUTC() {   // local zone is America/New_York here — the quirk is observable
        assertEquals(0.0, n("new Date('2026-03-04').getTime() - Date.parse('2026-03-04T00:00:00.000Z')"))
    }

    @Test
    fun d3_garbageIsNaN() {
        assertEquals(true, ev("isNaN(new Date('garbage').getTime())"))
        assertEquals(true, ev("isNaN(new Date('2026-03-04T05:06:07').getTime())"))   // T-form w/o zone: NaN (as iOS ships)
    }

    @Test
    fun dateLocalGetters() {   // pinned to America/New_York (UTC-5 in March before DST)
        put("d", "new Date('2026-03-04T05:06:07.890Z')")
        assertEquals(2026.0, n("d.getFullYear()"))
        assertEquals(2.0, n("d.getMonth()"))                       // 0-based
        assertEquals(4.0, n("d.getDate()"))
        assertEquals(3.0, n("d.getDay()"))                         // Wednesday, 0 = Sunday
        assertEquals(0.0, n("d.getHours()"))                       // 05:06 UTC = 00:06 EST
        assertEquals(6.0, n("d.getMinutes()"))
        assertEquals(7.0, n("d.getSeconds()"))
        // local-form parse: "yyyy-MM-dd HH:mm:ss" is LOCAL (round-trips through the getters)
        assertEquals(13.0, n("new Date('2026-03-04 13:30:00').getHours()"))
        // date arithmetic through number coercion
        assertEquals(86400000.0, n("new Date('2026-03-05').getTime() - new Date('2026-03-04').getTime()"))
    }

    // ── I1–I2: Intl (normalized: NBSP → space) ──────────────────────────────────────────

    private fun normalized(v: String): String = v.replace(' ', ' ').replace(' ', ' ')

    @Test
    fun i1_currencyUSD() {
        assertEquals("$9.99", normalized(s("new Intl.NumberFormat('en-US', { style:'currency', currency:'USD' }).format(9.99)")))
    }

    @Test
    fun i2_germanGroupingAndFractions() {
        assertEquals("1.234,6", normalized(s("new Intl.NumberFormat('de-DE', { maximumFractionDigits: 1 }).format(1234.56)")))
        assertEquals("1234,6", normalized(s("new Intl.NumberFormat('de-DE', { maximumFractionDigits: 1, useGrouping: false }).format(1234.56)")))
        assertEquals("50%", normalized(s("new Intl.NumberFormat('en-US', { style:'percent' }).format(0.5)")))
        assertEquals("7.00", normalized(s("new Intl.NumberFormat('en-US', { minimumFractionDigits: 2 }).format(7)")))
    }

    @Test
    fun intlDateTimeFormat() {
        put("d", "new Date('2026-03-04T17:06:07.890Z')")
        // dateStyle path (java.text styles)
        assertEquals("Mar 4, 2026", normalized(s("new Intl.DateTimeFormat('en-US', { dateStyle:'medium' }).format(d)")))
        // component-skeleton path (documented approximation — order from the locale's SHORT pattern)
        assertEquals("March 4, 2026", normalized(s("new Intl.DateTimeFormat('en-US', { year:'numeric', month:'long', day:'numeric' }).format(d)")))
    }

    @Test
    fun intlRelativeTimeFormat() {   // English-only :core fallback (documented)
        assertEquals("yesterday", s("new Intl.RelativeTimeFormat('en', { numeric:'auto' }).format(-1, 'day')"))
        assertEquals("in 3 days", s("new Intl.RelativeTimeFormat('en').format(3, 'days')"))
        assertEquals("2 hours ago", s("new Intl.RelativeTimeFormat('en').format(-2, 'hour')"))
    }

    // ── J1–J2 + N1: JSON / numbers ──────────────────────────────────────────────────────

    @Test
    fun j1_jsonParse() {
        assertEquals(2.0, n("JSON.parse('{\"a\":[1,2],\"b\":\"x\"}').a[1]"))
        assertEquals("x", s("JSON.parse('{\"a\":[1,2],\"b\":\"x\"}').b"))
        assertEquals(3.0, n("JSON.parse('3')"))                    // fragments allowed
        assertNull(ev("JSON.parse('{nope')"))                      // invalid → log + null
    }

    @Test
    fun j2_stringifyDates() {
        put("d", "new Date('2026-01-01T00:00:00.000Z')")
        assertEquals("{\"d\":\"2026-01-01T00:00:00.000Z\"}", s("JSON.stringify({ d: d })"))
    }

    @Test
    fun jsonStringifyShapes() {
        assertEquals("{\"a\":1,\"b\":[true,null]}", s("JSON.stringify({ a: 1, b: [true, null] })"))
        assertEquals("\"a\\/b\"", s("JSON.stringify('a/b')"))      // JSONSerialization escapes slashes
        assertEquals("1", s("JSON.stringify(1.0)"))                // integral doubles print as integers
        assertNull(ev("JSON.stringify(Number('x'))"))              // NaN → invalid (isValidJSONObject fail) → null
        // core shapes sanitize: URL → href; "__" keys never serialize
        put("u", "new URL('https://x.example.com/p')")
        assertEquals("{\"u\":\"https://x.example.com/p\"}", s("JSON.stringify({ u: u })").replace("\\/", "/"))
        // round trip
        assertEquals("k", s("JSON.parse(JSON.stringify({ k: 'k' })).k"))
    }

    @Test
    fun n1_parseIntParseFloat() {
        assertEquals(31.0, n("parseInt('0x1F')"))
        assertEquals(12.0, n("parseInt('12px')"))
        assertEquals(3.5, n("parseFloat('3.5kg')"))
        assertEquals(-42.0, n("parseInt('-42.9')"))
        assertEquals(255.0, n("parseInt('ff', 16)"))
        assertEquals(true, ev("isNaN(parseInt('px'))"))
        assertEquals(true, ev("isNaN(parseFloat('kg'))"))
        assertEquals(7.0, n("Number('7')"))
        assertEquals(true, ev("Boolean('0')"))                     // JSE truthiness: non-empty string
        assertEquals("1", s("String(true)"))                       // the pinned Bool print
    }

    // ── the remaining core shapes ───────────────────────────────────────────────────────

    @Test
    fun m1_m2_mapAndSet() {
        put("m", "new Map()")
        put("m", "m.set('a', 1)")
        put("m", "m.set('a', 2)")
        assertEquals("1:2", s("m.size + ':' + m.get('a')"))
        put("st", "new Set([1,1,2])")
        put("st", "st.add(2)")
        assertEquals(2.0, n("st.size"))
        assertEquals(true, ev("st.has(2)"))
        put("st", "st.delete(2)")
        assertEquals(1.0, n("st.size"))
    }

    @Test
    fun objectHelpers() {
        assertEquals("a,b", s("Object.keys({ a: 1, b: 2 }).join(',')"))
        assertEquals("1,2", s("Object.values({ a: 1, b: 2 }).join(',')"))
        assertEquals("a=1", s("Object.entries({ a: 1 }).map(e => e[0] + '=' + e[1]).join(',')"))  // bare-ident arrow (quirk fixed both runtimes — see identArrowAndClosureCapture)
        assertEquals(3.0, n("Object.assign({}, { a: 1 }, { a: 3 }).a"))
        assertEquals(5.0, n("Object.fromEntries([['k', 5]]).k"))
        assertEquals(2.0, n("structuredClone({ a: [1, 2] }).a[1]"))
    }

    @Test
    fun headersRequestBlob() {
        put("h", "new Headers({ 'Content-Type': 'text/plain' })")
        assertEquals("text/plain", s("h.get('content-type')"))     // lowercased keys
        assertEquals(true, ev("h.has('Content-Type')"))
        put("h", "h.set('X-Custom', 'v')")
        assertEquals("v", s("h.get('x-custom')"))
        put("r", "new Request('https://api.example.com/x', { method:'POST', body:'b' })")
        assertEquals("POST", s("r.method"))
        assertEquals("https://api.example.com/x", s("r.url"))
        put("b", "new Blob(['ab', 'cd'], { type:'text/x' })")
        assertEquals(4.0, n("b.size"))
        assertEquals("text/x", s("b.type"))
        put("f", "new File(['x'], 'a.txt', { type:'text/plain' })")
        assertEquals("a.txt", s("f.name"))
        put("fd", "new FormData()")
        put("fd", "fd.append('k', 'v')")
        assertEquals("v", s("fd.get('k')"))
        assertEquals("[object FormData]", s("fd.toString()"))
    }

    @Test
    fun errorRegexAbortMisc() {
        assertEquals("Error: boom", s("'' + new Error('boom')"))   // stringCoerce
        assertEquals(true, ev("new RegExp('^a+$', 'i').test('AAA')"))
        assertEquals("/x/g", s("'' + new RegExp('x', 'g')"))
        put("c", "new AbortController()")
        assertEquals(false, ev("c.signal.aborted"))
        assertTrue((n("performance.now()") ?: -1.0) >= 0.0)
        assertNull(ev("new WebSocket('wss://x.example.com')"))     // statement-only (logged)
    }
}
