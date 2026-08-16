//
//  JSELibrary.swift
//  DespiaScript
//
//  Despia LLC-FZ
//  Meydan Grandstand, 6th Floor, Meydan Road,
//  Nad Al Sheba, Dubai, United Arab Emirates
//  support@despia.com
//
//  The UIKit-free JSE RUNTIME LIBRARY - crypto.subtle (JSECrypto), the JS core
//  globals (JSECore: URL/Date/Intl/JSON/Math/Blob/FormData/Abort + console +
//  reachability), RegExp (JSERegex), and the log redaction/trace pair
//  (JSERedact/JSETrace) - extracted VERBATIM from Stack.swift so satellite-node
//  targets compile the SAME conformance-pinned semantics as the full engine:
//  JSE.swift references these types, and the watch target (RUNTIME_TIERS
//  'logic') compiles JSE.swift WITHOUT Stack.swift. Only the surface-scoped
//  WebSocket runtime (JSESocket) stays in Stack.swift - it holds StackStore/
//  UIView/Context, which never compile into a satellite node.
//  Extension-safety (no UIKit/WebKit) is enforced by check_module_rules.rb
//  [kernel-products extension-safe].
//

import Foundation
import CryptoKit
import CommonCrypto
import Security
import Network

// MARK: - The house console formatter (logs corpus) - one value -> one token.
// JSERunner.formatLogValue/formatLogArgs (Stack.swift) forward here so the
// module-handle dsx.log, the dsx.log statement, and console.* share ONE
// implementation on every target (the logs corpus pins the output).
enum JSELogFormat {
    /// The HOUSE log formatter — one value → one console token, shared by the `console.*`
    /// builtin (JSECore), the `dsx.log` statement, and the module-handle `dsx.log`
    /// (Context) — the logs corpus pins it: a dict/array serializes as canonical minified
    /// JSON with credential-looking keys masked (JSERedact); anything else takes the JSE
    /// string coercion.
    static func value(_ v: Any?) -> String {
        if let d = v as? [String: Any] {
            let clean = JSERedact.mask(JSECore.jsonSanitize(d))
            if let data = try? JSONSerialization.data(withJSONObject: clean, options: [.fragmentsAllowed]) {
                return String(decoding: data, as: UTF8.self)
            }
        }
        if let arr = v as? [Any], let data = try? JSONSerialization.data(withJSONObject: JSERedact.mask(JSECore.jsonSanitize(arr))) {
            return String(decoding: data, as: UTF8.self)
        }
        return JSE.string(v)
    }

    /// console.log-shaped variadic formatting: each argument through formatLogValue,
    /// joined by single spaces.
    static func args(_ a: [Any?]) -> String {
        a.map { value($0) }.joined(separator: " ")
    }
}

// MARK: - JSE · Web Crypto (1:1) — crypto.subtle → CryptoKit / CommonCrypto / SecKey
//
// The standard Web Crypto JS API, verbatim syntax, NO JS engine — every call maps to native
// crypto. Bytes travel as plain JSE number arrays (an ArrayBuffer/Uint8Array is array-like, so
// MDN idioms — `Array.from(new Uint8Array(buf))`, `.map(b => b.toString(16).padStart(2, '0'))`
// — run unchanged); strings auto-encode as UTF-8 where the spec takes a BufferSource. Keys are
// CryptoKey-shaped dicts ({ type, extractable, algorithm, usages }) carrying their material in
// internal fields — value semantics, no handle registry to leak.
//
//   crypto.randomUUID() · crypto.getRandomValues(new Uint8Array(n))         (sync)
//   await crypto.subtle.digest('SHA-256', data)                              SHA-1/256/384/512
//   await crypto.subtle.generateKey / importKey / exportKey                  raw · spki · pkcs8 · jwk
//   await crypto.subtle.encrypt / decrypt        AES-GCM · AES-CBC · AES-CTR · RSA-OAEP
//   await crypto.subtle.sign / verify            HMAC · ECDSA (P-256/384/521) · Ed25519 ·
//                                                RSASSA-PKCS1-v1_5 · RSA-PSS
//   await crypto.subtle.deriveBits / deriveKey   PBKDF2 · HKDF · ECDH · X25519
//   await crypto.subtle.wrapKey / unwrapKey      via encrypt/decrypt + AES-KW
//
// Statement-level `await crypto.subtle.*` suspends off the main thread (the fetch contract);
// in expression position the same calls evaluate synchronously (`await v` on a non-promise is
// `v`). Total like all of JSE: unsupported algorithm/key/params log `[JSE crypto]` and yield
// null — nothing throws across the engine boundary. Documented limits: AES-GCM tagLength is
// 128; RSA publicExponent is 65537; RSA-PSS saltLength must equal the hash length (SecKey);
// RSA-OAEP labels unsupported. Companion globals shipped for the idioms: Uint8Array(…),
// Uint8Array.fromHex/fromBase64, bytes.toHex()/.toBase64(), TextEncoder/TextDecoder,
// Array.from, btoa/atob. See OpenSource/Documentation/reference/jse.md → "Web Crypto".

enum JSECrypto {
    private enum Err: Swift.Error { case e(String) }
    private static func fail(_ m: String) -> Err { Err.e(m) }

    // ── value plumbing ─────────────────────────────────────────────────────────────────────
    /// BufferSource coercion: a JSE number array (bytes), a String (UTF-8), or a key dict's
    /// raw material. Returns nil for anything else.
    static func data(_ v: Any?) -> Data? {
        if let arr = v as? [Any] {
            var d = Data(capacity: arr.count)
            for e in arr { guard let n = JSE.number(e) else { return nil }; d.append(UInt8(truncatingIfNeeded: Int(n))) }
            return d
        }
        if let s = v as? String { return Data(s.utf8) }
        return nil
    }
    /// Data → the JSE byte array ([Double] 0–255) every result travels as.
    static func bytes(_ d: Data) -> [Any] { d.map { Double($0) } }

    private static func str(_ v: Any?) -> String { JSE.string(v) }
    private static func b64url(_ d: Data) -> String {
        d.base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
    private static func b64urlDecode(_ s: String) -> Data? {
        var b = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while b.count % 4 != 0 { b += "=" }
        return Data(base64Encoded: b)
    }

    /// AlgorithmIdentifier: a bare string ('SHA-256') or a dict ({ name: 'AES-GCM', iv }).
    private static func algName(_ v: Any?) -> String {
        if let d = v as? [String: Any] { return str(d["name"]).uppercased() }
        return str(v).uppercased()
    }
    private static func algDict(_ v: Any?) -> [String: Any] { (v as? [String: Any]) ?? ["name": str(v)] }
    /// The hash member ('SHA-256' or { name: 'SHA-256' }) of an algorithm dict — or the bare alg.
    private static func hashName(_ v: Any?) -> String {
        let d = algDict(v)
        if let h = d["hash"] { return algName(h) }
        return algName(v)
    }

    // ── CryptoKey dicts (CryptoKey-shaped; material rides internal fields) ─────────────────
    private static func key(kind: String, type: String, material: Data, algorithm: [String: Any],
                            extractable: Bool, usages: [Any]) -> [String: Any] {
        ["type": type, "extractable": extractable, "algorithm": algorithm, "usages": usages,
         "__kind": kind, "__k": material.base64EncodedString()]
    }
    private static func material(_ k: Any?) throws -> Data {
        guard let d = k as? [String: Any], let b = d["__k"] as? String, let m = Data(base64Encoded: b)
        else { throw fail("not a CryptoKey") }
        return m
    }
    private static func kind(_ k: Any?) -> String { str((k as? [String: Any])?["__kind"]) }
    private static func keyAlg(_ k: Any?) -> [String: Any] { ((k as? [String: Any])?["algorithm"] as? [String: Any]) ?? [:] }

    // ── entry ──────────────────────────────────────────────────────────────────────────────
    static func call(_ name: String, _ a: [Any?]) -> Any? {
        do { return try dispatch(name, a) }
        catch Err.e(let m) { NSLog("[JSE crypto] %@: %@", name, m); return nil }
        catch { NSLog("[JSE crypto] %@: %@", name, "\(error)"); return nil }
    }

    private static func dispatch(_ name: String, _ a: [Any?]) throws -> Any? {
        func arg(_ i: Int) -> Any? { i < a.count ? a[i] : nil }
        switch name {
        // ── companion globals ──
        case "Uint8Array":
            if let n = JSE.number(arg(0)), !(arg(0) is [Any]) { return [Any](repeating: Double(0), count: max(0, Int(n))) }
            if let d = data(arg(0)) { return bytes(d) }
            return [Any]()
        case "Uint8Array.fromHex":
            let s = str(arg(0)).replacingOccurrences(of: " ", with: "")
            guard s.count % 2 == 0 else { throw fail("odd hex length") }
            var d = Data(); var i = s.startIndex
            while i < s.endIndex {
                let j = s.index(i, offsetBy: 2)
                guard let b = UInt8(s[i..<j], radix: 16) else { throw fail("bad hex") }
                d.append(b); i = j
            }
            return bytes(d)
        case "Uint8Array.fromBase64":
            guard let d = Data(base64Encoded: str(arg(0))) ?? b64urlDecode(str(arg(0))) else { throw fail("bad base64") }
            return bytes(d)
        case "TextEncoder": return ["__textEncoder": true]
        case "TextDecoder": return ["__textDecoder": true]
        case "Array.from":  return (arg(0) as? [Any]) ?? data(arg(0)).map(bytes) ?? [Any]()
        case "btoa":
            return Data(str(arg(0)).unicodeScalars.map { UInt8(truncatingIfNeeded: $0.value) }).base64EncodedString()
        case "atob":
            guard let d = Data(base64Encoded: str(arg(0))) else { throw fail("bad base64") }
            return String(String.UnicodeScalarView(d.map { Unicode.Scalar($0) }))

        // ── crypto.* ──
        case "crypto.randomUUID": return UUID().uuidString.lowercased()
        case "crypto.getRandomValues":
            // clamped — a raw Int(Double) would trap on NaN/∞/huge author input
            let rawCount = JSE.number(arg(0)) ?? 0
            let count = (arg(0) as? [Any])?.count ?? (rawCount.isNaN ? 0 : Int(Swift.min(Swift.max(rawCount, 0), 65537)))
            guard count > 0, count <= 65536 else { throw fail("getRandomValues: 1…65536 bytes") }
            var d = Data(count: count)
            let ok = d.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, count, $0.baseAddress!) }
            guard ok == errSecSuccess else { throw fail("SecRandomCopyBytes failed") }
            return bytes(d)

        // ── crypto.subtle.* ──
        case "crypto.subtle.digest":
            guard let d = data(arg(1)) else { throw fail("digest: data required") }
            return bytes(try digest(hashName(arg(0)), d))
        case "crypto.subtle.sign":      return bytes(try sign(arg(0), key: arg(1), data: data(arg(2)) ?? Data()))
        case "crypto.subtle.verify":    return try verify(arg(0), key: arg(1), signature: data(arg(2)) ?? Data(), data: data(arg(3)) ?? Data())
        case "crypto.subtle.encrypt":   return bytes(try encrypt(arg(0), key: arg(1), data: data(arg(2)) ?? Data()))
        case "crypto.subtle.decrypt":   return bytes(try decrypt(arg(0), key: arg(1), data: data(arg(2)) ?? Data()))
        case "crypto.subtle.generateKey": return try generateKey(arg(0), extractable: JSE.truthy(arg(1)), usages: (arg(2) as? [Any]) ?? [])
        case "crypto.subtle.importKey":   return try importKey(str(arg(0)), keyData: arg(1), alg: arg(2), extractable: JSE.truthy(arg(3)), usages: (arg(4) as? [Any]) ?? [])
        case "crypto.subtle.exportKey":   return try exportKey(str(arg(0)), key: arg(1))
        case "crypto.subtle.deriveBits":  return bytes(try deriveBits(arg(0), key: arg(1), lengthBits: arg(2).flatMap { JSE.number($0) }.map(Int.init)))
        case "crypto.subtle.deriveKey":
            let raw = try deriveBits(arg(0), key: arg(1), lengthBits: derivedKeyLengthBits(arg(2)))
            return try importKey("raw", keyData: bytes(raw), alg: arg(2), extractable: JSE.truthy(arg(3)), usages: (arg(4) as? [Any]) ?? [])
        case "crypto.subtle.wrapKey":
            let exported = try exportKey(str(arg(0)), key: arg(1))
            let payload: Data = str(arg(0)) == "jwk"
                ? Data((try jsonString(exported)).utf8)
                : (data(exported) ?? Data())
            if algName(arg(3)) == "AES-KW" { return bytes(try aesKeyWrap(payload, kek: try material(arg(2)))) }
            return bytes(try encrypt(arg(3), key: arg(2), data: payload))
        case "crypto.subtle.unwrapKey":
            let wrapped = data(arg(1)) ?? Data()
            let raw: Data = algName(arg(3)) == "AES-KW"
                ? try aesKeyUnwrap(wrapped, kek: try material(arg(2)))
                : try decrypt(arg(3), key: arg(2), data: wrapped)
            let keyData: Any? = str(arg(0)) == "jwk"
                ? try JSONSerialization.jsonObject(with: raw)
                : bytes(raw)
            return try importKey(str(arg(0)), keyData: keyData, alg: arg(4), extractable: JSE.truthy(arg(5)), usages: (arg(6) as? [Any]) ?? [])
        default:
            throw fail("unsupported: \(name)")
        }
    }

    private static func jsonString(_ v: Any?) throws -> String {
        guard let v, JSONSerialization.isValidJSONObject(v),
              let d = try? JSONSerialization.data(withJSONObject: v, options: [.sortedKeys])
        else { throw fail("jwk serialization") }
        return String(decoding: d, as: UTF8.self)
    }
    private static func derivedKeyLengthBits(_ alg: Any?) -> Int? {
        let d = algDict(alg)
        if let l = d["length"].flatMap({ JSE.number($0) }) { return Int(l) }
        switch algName(alg) {                       // HMAC default key = hash block size
        case "HMAC":
            switch hashName(alg) {
            case "SHA-384", "SHA-512": return 1024
            default: return 512
            }
        default: return 256                         // AES-* default in deriveKey
        }
    }

    // ── digest ─────────────────────────────────────────────────────────────────────────────
    private static func digest(_ alg: String, _ d: Data) throws -> Data {
        switch alg {
        case "SHA-1":   return Data(Insecure.SHA1.hash(data: d))
        case "SHA-256": return Data(SHA256.hash(data: d))
        case "SHA-384": return Data(SHA384.hash(data: d))
        case "SHA-512": return Data(SHA512.hash(data: d))
        default: throw fail("digest: \(alg)")
        }
    }

    // ── HMAC ───────────────────────────────────────────────────────────────────────────────
    private static func hmac(_ hash: String, key: Data, data: Data) throws -> Data {
        let k = SymmetricKey(data: key)
        switch hash {
        case "SHA-1":   return Data(HMAC<Insecure.SHA1>.authenticationCode(for: data, using: k))
        case "SHA-256": return Data(HMAC<SHA256>.authenticationCode(for: data, using: k))
        case "SHA-384": return Data(HMAC<SHA384>.authenticationCode(for: data, using: k))
        case "SHA-512": return Data(HMAC<SHA512>.authenticationCode(for: data, using: k))
        default: throw fail("HMAC hash: \(hash)")
        }
    }

    // ── sign / verify ──────────────────────────────────────────────────────────────────────
    private static func sign(_ alg: Any?, key: Any?, data d: Data) throws -> Data {
        let m = try material(key)
        switch algName(alg) {
        case "HMAC":
            return try hmac(hashName(keyAlg(key)), key: m, data: d)
        case "ECDSA":
            return try ecdsaSign(curve: str(keyAlg(key)["namedCurve"]), hash: hashName(alg), priv: m, data: d)
        case "ED25519":
            return try Data(Curve25519.Signing.PrivateKey(rawRepresentation: m).signature(for: d))
        case "RSASSA-PKCS1-V1_5", "RSA-PSS":
            return try rsaSign(algName(alg), hash: hashName(keyAlg(key)), alg: alg, key: key, data: d)
        default: throw fail("sign: \(algName(alg))")
        }
    }
    private static func verify(_ alg: Any?, key: Any?, signature: Data, data d: Data) throws -> Bool {
        let m = try material(key)
        switch algName(alg) {
        case "HMAC":
            let mac = try hmac(hashName(keyAlg(key)), key: m, data: d)
            return mac.count == signature.count && mac.withUnsafeBytes { a in signature.withUnsafeBytes { b in
                timingsafe_bcmp_shim(a.baseAddress, b.baseAddress, mac.count) == 0 } }
        case "ECDSA":
            return try ecdsaVerify(curve: str(keyAlg(key)["namedCurve"]), hash: hashName(alg), pub: m, signature: signature, data: d)
        case "ED25519":
            return (try? Curve25519.Signing.PublicKey(rawRepresentation: m))?.isValidSignature(signature, for: d) ?? false
        case "RSASSA-PKCS1-V1_5", "RSA-PSS":
            return try rsaVerify(algName(alg), hash: hashName(keyAlg(key)), alg: alg, key: key, signature: signature, data: d)
        default: throw fail("verify: \(algName(alg))")
        }
    }
    /// memcmp is fine for HMAC verify ordering here (tag already fixed-length), but keep it
    /// constant-time anyway — a tiny shim so we don't import libplatform.
    private static func timingsafe_bcmp_shim(_ a: UnsafeRawPointer?, _ b: UnsafeRawPointer?, _ n: Int) -> Int {
        guard let a, let b else { return 1 }
        var diff: UInt8 = 0
        for i in 0..<n { diff |= a.load(fromByteOffset: i, as: UInt8.self) ^ b.load(fromByteOffset: i, as: UInt8.self) }
        return Int(diff)
    }

    // ── encrypt / decrypt ──────────────────────────────────────────────────────────────────
    private static func encrypt(_ alg: Any?, key: Any?, data d: Data) throws -> Data {
        let p = algDict(alg)
        switch algName(alg) {
        case "AES-GCM":
            if let t = p["tagLength"].flatMap({ JSE.number($0) }), Int(t) != 128 { throw fail("AES-GCM tagLength: 128 only") }
            guard let iv = data(p["iv"]) else { throw fail("AES-GCM: iv required") }
            let box = try AES.GCM.seal(d, using: SymmetricKey(data: try material(key)),
                                       nonce: AES.GCM.Nonce(data: iv),
                                       authenticating: data(p["additionalData"]) ?? Data())
            return box.ciphertext + box.tag                      // WebCrypto: ciphertext ‖ tag
        case "AES-CBC":
            guard let iv = data(p["iv"]), iv.count == 16 else { throw fail("AES-CBC: 16-byte iv required") }
            return try aesCBC(encrypt: true, key: try material(key), iv: iv, data: d)
        case "AES-CTR":
            guard let counter = data(p["counter"]), counter.count == 16 else { throw fail("AES-CTR: 16-byte counter required") }
            return try aesCTR(encrypt: true, key: try material(key), counter: counter, data: d)
        case "RSA-OAEP":
            if p["label"] != nil { throw fail("RSA-OAEP: label unsupported") }
            return try rsaCrypt(encrypt: true, hash: hashName(keyAlg(key)), key: key, data: d)
        default: throw fail("encrypt: \(algName(alg))")
        }
    }
    private static func decrypt(_ alg: Any?, key: Any?, data d: Data) throws -> Data {
        let p = algDict(alg)
        switch algName(alg) {
        case "AES-GCM":
            guard let iv = data(p["iv"]), d.count >= 16 else { throw fail("AES-GCM: iv/ciphertext") }
            let box = try AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: iv),
                                            ciphertext: d.prefix(d.count - 16), tag: d.suffix(16))
            return try AES.GCM.open(box, using: SymmetricKey(data: try material(key)),
                                    authenticating: data(p["additionalData"]) ?? Data())
        case "AES-CBC":
            guard let iv = data(p["iv"]), iv.count == 16 else { throw fail("AES-CBC: 16-byte iv required") }
            return try aesCBC(encrypt: false, key: try material(key), iv: iv, data: d)
        case "AES-CTR":
            guard let counter = data(p["counter"]), counter.count == 16 else { throw fail("AES-CTR: 16-byte counter required") }
            return try aesCTR(encrypt: false, key: try material(key), counter: counter, data: d)
        case "RSA-OAEP":
            if p["label"] != nil { throw fail("RSA-OAEP: label unsupported") }
            return try rsaCrypt(encrypt: false, hash: hashName(keyAlg(key)), key: key, data: d)
        default: throw fail("decrypt: \(algName(alg))")
        }
    }

    private static func aesCBC(encrypt: Bool, key: Data, iv: Data, data d: Data) throws -> Data {
        var out = Data(count: d.count + kCCBlockSizeAES128)
        var moved = 0
        let status = out.withUnsafeMutableBytes { ob in
            d.withUnsafeBytes { db in key.withUnsafeBytes { kb in iv.withUnsafeBytes { vb in
                CCCrypt(CCOperation(encrypt ? kCCEncrypt : kCCDecrypt), CCAlgorithm(kCCAlgorithmAES),
                        CCOptions(kCCOptionPKCS7Padding), kb.baseAddress, key.count, vb.baseAddress,
                        db.baseAddress, d.count, ob.baseAddress, ob.count, &moved)
            } } }
        }
        guard status == CCCryptorStatus(kCCSuccess) else { throw fail("AES-CBC: CCCrypt \(status)") }
        return out.prefix(moved)
    }
    private static func aesCTR(encrypt: Bool, key: Data, counter: Data, data d: Data) throws -> Data {
        var cryptor: CCCryptorRef?
        let create = key.withUnsafeBytes { kb in counter.withUnsafeBytes { cb in
            CCCryptorCreateWithMode(CCOperation(encrypt ? kCCEncrypt : kCCDecrypt), CCMode(kCCModeCTR),
                                    CCAlgorithm(kCCAlgorithmAES), CCPadding(ccNoPadding),
                                    cb.baseAddress, kb.baseAddress, key.count, nil, 0, 0,
                                    CCModeOptions(kCCModeOptionCTR_BE), &cryptor)
        } }
        guard create == CCCryptorStatus(kCCSuccess), let cryptor else { throw fail("AES-CTR: create \(create)") }
        defer { CCCryptorRelease(cryptor) }
        var out = Data(count: d.count + kCCBlockSizeAES128)
        var moved = 0, total = 0
        let upd = out.withUnsafeMutableBytes { ob in d.withUnsafeBytes { db in
            CCCryptorUpdate(cryptor, db.baseAddress, d.count, ob.baseAddress, ob.count, &moved)
        } }
        guard upd == CCCryptorStatus(kCCSuccess) else { throw fail("AES-CTR: update \(upd)") }
        total = moved
        let fin = out.withUnsafeMutableBytes { ob in
            CCCryptorFinal(cryptor, ob.baseAddress!.advanced(by: total), ob.count - total, &moved)
        }
        guard fin == CCCryptorStatus(kCCSuccess) else { throw fail("AES-CTR: final \(fin)") }
        return out.prefix(total + moved)
    }
    private static func aesKeyWrap(_ payload: Data, kek: Data) throws -> Data {
        guard #available(iOS 15.0, *) else { throw fail("AES-KW: iOS 15+") }
        return try AES.KeyWrap.wrap(SymmetricKey(data: payload), using: SymmetricKey(data: kek))
    }
    private static func aesKeyUnwrap(_ wrapped: Data, kek: Data) throws -> Data {
        guard #available(iOS 15.0, *) else { throw fail("AES-KW: iOS 15+") }
        let k = try AES.KeyWrap.unwrap(wrapped, using: SymmetricKey(data: kek))
        return k.withUnsafeBytes { Data($0) }
    }

    // ── deriveBits: PBKDF2 · HKDF · ECDH · X25519 ─────────────────────────────────────────
    private static func deriveBits(_ alg: Any?, key: Any?, lengthBits: Int?) throws -> Data {
        let p = algDict(alg)
        switch algName(alg) {
        case "PBKDF2":
            guard let bits = lengthBits, bits > 0, bits % 8 == 0 else { throw fail("PBKDF2: length (bits, ×8)") }
            guard let salt = data(p["salt"]) else { throw fail("PBKDF2: salt required") }
            let iterations = Int(p["iterations"].flatMap { JSE.number($0) } ?? 0)
            guard iterations > 0 else { throw fail("PBKDF2: iterations required") }
            let prf: CCPseudoRandomAlgorithm
            switch hashName(p["hash"]) {
            case "SHA-1":   prf = CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA1)
            case "SHA-256": prf = CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA256)
            case "SHA-384": prf = CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA384)
            case "SHA-512": prf = CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA512)
            default: throw fail("PBKDF2 hash")
            }
            let pass = try material(key)
            var out = Data(count: bits / 8)
            let status = out.withUnsafeMutableBytes { ob in
                pass.withUnsafeBytes { pb in salt.withUnsafeBytes { sb in
                    CCKeyDerivationPBKDF(CCPBKDFAlgorithm(kCCPBKDF2),
                                         pb.bindMemory(to: Int8.self).baseAddress, pass.count,
                                         sb.bindMemory(to: UInt8.self).baseAddress, salt.count,
                                         prf, UInt32(iterations),
                                         ob.bindMemory(to: UInt8.self).baseAddress, bits / 8)
                } }
            }
            guard status == CCCryptorStatus(kCCSuccess) else { throw fail("PBKDF2: \(status)") }
            return out
        case "HKDF":
            guard #available(iOS 14.0, *) else { throw fail("HKDF: iOS 14+") }
            guard let bits = lengthBits, bits > 0, bits % 8 == 0 else { throw fail("HKDF: length (bits, ×8)") }
            let ikm = SymmetricKey(data: try material(key))
            let salt = data(p["salt"]) ?? Data(), info = data(p["info"]) ?? Data()
            let derived: SymmetricKey
            switch hashName(p["hash"]) {
            case "SHA-1":   derived = HKDF<Insecure.SHA1>.deriveKey(inputKeyMaterial: ikm, salt: salt, info: info, outputByteCount: bits / 8)
            case "SHA-256": derived = HKDF<SHA256>.deriveKey(inputKeyMaterial: ikm, salt: salt, info: info, outputByteCount: bits / 8)
            case "SHA-384": derived = HKDF<SHA384>.deriveKey(inputKeyMaterial: ikm, salt: salt, info: info, outputByteCount: bits / 8)
            case "SHA-512": derived = HKDF<SHA512>.deriveKey(inputKeyMaterial: ikm, salt: salt, info: info, outputByteCount: bits / 8)
            default: throw fail("HKDF hash")
            }
            return derived.withUnsafeBytes { Data($0) }
        case "ECDH":
            guard let pub = p["public"] else { throw fail("ECDH: public key required") }
            let secret = try ecdh(curve: str(keyAlg(key)["namedCurve"]), priv: try material(key), pub: try material(pub))
            return lengthBits.map { secret.prefix($0 / 8) } ?? secret
        case "X25519":
            guard let pub = p["public"] else { throw fail("X25519: public key required") }
            let sk = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: try material(key))
            let pk = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: try material(pub))
            let secret = try sk.sharedSecretFromKeyAgreement(with: pk).withUnsafeBytes { Data($0) }
            return lengthBits.map { secret.prefix($0 / 8) } ?? secret
        default: throw fail("deriveBits: \(algName(alg))")
        }
    }

    // ── generateKey ────────────────────────────────────────────────────────────────────────
    private static func generateKey(_ alg: Any?, extractable: Bool, usages: [Any]) throws -> Any? {
        let p = algDict(alg)
        switch algName(alg) {
        case "AES-GCM", "AES-CBC", "AES-CTR", "AES-KW":
            let bits = Int(p["length"].flatMap { JSE.number($0) } ?? 256)
            guard [128, 192, 256].contains(bits) else { throw fail("AES length: 128/192/256") }
            return key(kind: "aes", type: "secret", material: random(bits / 8),
                       algorithm: ["name": algName(alg), "length": Double(bits)],
                       extractable: extractable, usages: usages)
        case "HMAC":
            let hash = hashName(alg)
            let defBytes = (hash == "SHA-384" || hash == "SHA-512") ? 128 : 64       // hash block size
            let bits = Int(p["length"].flatMap { JSE.number($0) } ?? Double(defBytes * 8))
            return key(kind: "hmac", type: "secret", material: random(bits / 8),
                       algorithm: ["name": "HMAC", "hash": ["name": hash], "length": Double(bits)],
                       extractable: extractable, usages: usages)
        case "ECDSA", "ECDH":
            return try ecGenerate(algName(alg), curve: str(p["namedCurve"]), extractable: extractable, usages: usages)
        case "ED25519":
            let sk = Curve25519.Signing.PrivateKey()
            return ["publicKey":  key(kind: "ed25519", type: "public",  material: sk.publicKey.rawRepresentation,
                                      algorithm: ["name": "Ed25519"], extractable: true, usages: usages),
                    "privateKey": key(kind: "ed25519", type: "private", material: sk.rawRepresentation,
                                      algorithm: ["name": "Ed25519"], extractable: extractable, usages: usages)]
        case "X25519":
            let sk = Curve25519.KeyAgreement.PrivateKey()
            return ["publicKey":  key(kind: "x25519", type: "public",  material: sk.publicKey.rawRepresentation,
                                      algorithm: ["name": "X25519"], extractable: true, usages: usages),
                    "privateKey": key(kind: "x25519", type: "private", material: sk.rawRepresentation,
                                      algorithm: ["name": "X25519"], extractable: extractable, usages: usages)]
        case "RSASSA-PKCS1-V1_5", "RSA-PSS", "RSA-OAEP":
            return try rsaGenerate(algName(alg), p, extractable: extractable, usages: usages)
        default: throw fail("generateKey: \(algName(alg))")
        }
    }
    private static func random(_ n: Int) -> Data {
        var d = Data(count: n)
        _ = d.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, n, $0.baseAddress!) }
        return d
    }

    // ── importKey / exportKey ──────────────────────────────────────────────────────────────
    private static func importKey(_ format: String, keyData: Any?, alg: Any?, extractable: Bool, usages: [Any]) throws -> Any? {
        let p = algDict(alg)
        let name = algName(alg)
        switch name {
        case "AES-GCM", "AES-CBC", "AES-CTR", "AES-KW", "PBKDF2", "HKDF", "HMAC":
            let raw: Data
            switch format {
            case "raw": guard let d = data(keyData) else { throw fail("raw key data") }; raw = d
            case "jwk":
                guard let j = keyData as? [String: Any], str(j["kty"]) == "oct",
                      let d = b64urlDecode(str(j["k"])) else { throw fail("jwk oct") }
                raw = d
            default: throw fail("\(name): raw/jwk only")
            }
            var algorithm: [String: Any] = ["name": name]
            if name == "HMAC" { algorithm["hash"] = ["name": hashName(alg)]; algorithm["length"] = Double(raw.count * 8) }
            if name.hasPrefix("AES") { algorithm["length"] = Double(raw.count * 8) }
            let kindName = name == "HMAC" ? "hmac" : (name.hasPrefix("AES") ? "aes" : "kdf")
            return key(kind: kindName, type: "secret", material: raw, algorithm: algorithm,
                       extractable: extractable, usages: usages)
        case "ECDSA", "ECDH":
            return try ecImport(format, keyData: keyData, name: name, curve: str(p["namedCurve"]),
                                extractable: extractable, usages: usages)
        case "ED25519", "X25519":
            return try okpImport(format, keyData: keyData, name: name == "ED25519" ? "Ed25519" : "X25519",
                                 extractable: extractable, usages: usages)
        case "RSASSA-PKCS1-V1_5", "RSA-PSS", "RSA-OAEP":
            return try rsaImport(format, keyData: keyData, alg: alg, extractable: extractable, usages: usages)
        default: throw fail("importKey: \(name)")
        }
    }
    private static func exportKey(_ format: String, key k: Any?) throws -> Any? {
        guard let dict = k as? [String: Any] else { throw fail("not a CryptoKey") }
        guard (dict["extractable"] as? Bool) ?? JSE.truthy(dict["extractable"]) else { throw fail("key not extractable") }
        let m = try material(k)
        switch kind(k) {
        case "aes", "hmac", "kdf":
            switch format {
            case "raw": return bytes(m)
            case "jwk": return ["kty": "oct", "k": b64url(m), "ext": true]
            default: throw fail("exportKey: raw/jwk")
            }
        case "ec-pub", "ec-priv":   return try ecExport(format, key: k, material: m)
        case "ed25519", "x25519":   return try okpExport(format, key: k, material: m)
        case "rsa-pub", "rsa-priv": return try rsaExport(format, key: k, material: m)
        default: throw fail("exportKey: \(kind(k))")
        }
    }

    // ── EC (P-256 / P-384 / P-521) ────────────────────────────────────────────────────────
    private static func ecGenerate(_ name: String, curve: String, extractable: Bool, usages: [Any]) throws -> Any? {
        func pack(_ pubX963: Data, _ privRaw: Data) -> [String: Any] {
            let algorithm: [String: Any] = ["name": name == "ECDSA" ? "ECDSA" : "ECDH", "namedCurve": curve]
            return ["publicKey":  key(kind: "ec-pub",  type: "public",  material: pubX963, algorithm: algorithm, extractable: true, usages: usages),
                    "privateKey": key(kind: "ec-priv", type: "private", material: privRaw, algorithm: algorithm, extractable: extractable, usages: usages)]
        }
        switch curve {
        case "P-256": let k = P256.Signing.PrivateKey(); return pack(k.publicKey.x963Representation, k.rawRepresentation)
        case "P-384": let k = P384.Signing.PrivateKey(); return pack(k.publicKey.x963Representation, k.rawRepresentation)
        case "P-521": let k = P521.Signing.PrivateKey(); return pack(k.publicKey.x963Representation, k.rawRepresentation)
        default: throw fail("namedCurve: \(curve)")
        }
    }
    private static func ecImport(_ format: String, keyData: Any?, name: String, curve: String,
                                 extractable: Bool, usages: [Any]) throws -> Any? {
        let algorithm: [String: Any] = ["name": name == "ECDSA" ? "ECDSA" : "ECDH", "namedCurve": curve]
        func pub(_ m: Data) -> [String: Any] { key(kind: "ec-pub", type: "public", material: m, algorithm: algorithm, extractable: extractable, usages: usages) }
        func priv(_ m: Data) -> [String: Any] { key(kind: "ec-priv", type: "private", material: m, algorithm: algorithm, extractable: extractable, usages: usages) }
        switch format {
        case "raw":
            guard let d = data(keyData) else { throw fail("raw") }
            _ = try ecPublicX963(curve, d)                       // validate
            return pub(d)
        case "jwk":
            guard let j = keyData as? [String: Any], str(j["kty"]) == "EC" else { throw fail("jwk EC") }
            if let dPart = j["d"] {
                guard let dd = b64urlDecode(str(dPart)) else { throw fail("jwk d") }
                _ = try ecPrivateRaw(curve, dd)
                return priv(dd)
            }
            guard let x = b64urlDecode(str(j["x"])), let y = b64urlDecode(str(j["y"])) else { throw fail("jwk x/y") }
            let m = Data([0x04]) + x + y
            _ = try ecPublicX963(curve, m)
            return pub(m)
        case "spki":
            guard #available(iOS 14.0, *), let d = data(keyData) else { throw fail("spki: iOS 14+") }
            switch curve {
            case "P-256": return pub(try P256.Signing.PublicKey(derRepresentation: d).x963Representation)
            case "P-384": return pub(try P384.Signing.PublicKey(derRepresentation: d).x963Representation)
            case "P-521": return pub(try P521.Signing.PublicKey(derRepresentation: d).x963Representation)
            default: throw fail("namedCurve")
            }
        case "pkcs8":
            guard #available(iOS 14.0, *), let d = data(keyData) else { throw fail("pkcs8: iOS 14+") }
            switch curve {
            case "P-256": return priv(try P256.Signing.PrivateKey(derRepresentation: d).rawRepresentation)
            case "P-384": return priv(try P384.Signing.PrivateKey(derRepresentation: d).rawRepresentation)
            case "P-521": return priv(try P521.Signing.PrivateKey(derRepresentation: d).rawRepresentation)
            default: throw fail("namedCurve")
            }
        default: throw fail("ecImport: \(format)")
        }
    }
    private static func ecExport(_ format: String, key k: Any?, material m: Data) throws -> Any? {
        let curve = str(keyAlg(k)["namedCurve"])
        let isPriv = kind(k) == "ec-priv"
        switch format {
        case "raw":
            guard !isPriv else { throw fail("raw export: public keys only") }
            return bytes(m)
        case "jwk":
            if isPriv {
                let pubX963 = try ecPublicFromPrivate(curve, m)
                let coords = pubX963.dropFirst()
                let half = coords.count / 2
                return ["kty": "EC", "crv": curve, "x": b64url(coords.prefix(half)),
                        "y": b64url(coords.suffix(half)), "d": b64url(m), "ext": true]
            }
            let coords = m.dropFirst()                      // strip 0x04
            let half = coords.count / 2
            return ["kty": "EC", "crv": curve, "x": b64url(coords.prefix(half)),
                    "y": b64url(coords.suffix(half)), "ext": true]
        case "spki":
            guard #available(iOS 14.0, *), !isPriv else { throw fail("spki: public, iOS 14+") }
            return bytes(try ecPublicDER(curve, m))
        case "pkcs8":
            guard #available(iOS 14.0, *), isPriv else { throw fail("pkcs8: private, iOS 14+") }
            return bytes(try ecPrivateDER(curve, m))
        default: throw fail("ecExport: \(format)")
        }
    }
    // typed-curve helpers (validate + convert; each switch is total over the supported curves)
    private static func ecPublicX963(_ curve: String, _ d: Data) throws -> Data {
        switch curve {
        case "P-256": return try P256.Signing.PublicKey(x963Representation: d).x963Representation
        case "P-384": return try P384.Signing.PublicKey(x963Representation: d).x963Representation
        case "P-521": return try P521.Signing.PublicKey(x963Representation: d).x963Representation
        default: throw fail("namedCurve: \(curve)")
        }
    }
    private static func ecPrivateRaw(_ curve: String, _ d: Data) throws -> Data {
        switch curve {
        case "P-256": return try P256.Signing.PrivateKey(rawRepresentation: d).rawRepresentation
        case "P-384": return try P384.Signing.PrivateKey(rawRepresentation: d).rawRepresentation
        case "P-521": return try P521.Signing.PrivateKey(rawRepresentation: d).rawRepresentation
        default: throw fail("namedCurve: \(curve)")
        }
    }
    private static func ecPublicFromPrivate(_ curve: String, _ d: Data) throws -> Data {
        switch curve {
        case "P-256": return try P256.Signing.PrivateKey(rawRepresentation: d).publicKey.x963Representation
        case "P-384": return try P384.Signing.PrivateKey(rawRepresentation: d).publicKey.x963Representation
        case "P-521": return try P521.Signing.PrivateKey(rawRepresentation: d).publicKey.x963Representation
        default: throw fail("namedCurve: \(curve)")
        }
    }
    @available(iOS 14.0, *)
    private static func ecPublicDER(_ curve: String, _ x963: Data) throws -> Data {
        switch curve {
        case "P-256": return try P256.Signing.PublicKey(x963Representation: x963).derRepresentation
        case "P-384": return try P384.Signing.PublicKey(x963Representation: x963).derRepresentation
        case "P-521": return try P521.Signing.PublicKey(x963Representation: x963).derRepresentation
        default: throw fail("namedCurve: \(curve)")
        }
    }
    @available(iOS 14.0, *)
    private static func ecPrivateDER(_ curve: String, _ raw: Data) throws -> Data {
        switch curve {
        case "P-256": return try P256.Signing.PrivateKey(rawRepresentation: raw).derRepresentation
        case "P-384": return try P384.Signing.PrivateKey(rawRepresentation: raw).derRepresentation
        case "P-521": return try P521.Signing.PrivateKey(rawRepresentation: raw).derRepresentation
        default: throw fail("namedCurve: \(curve)")
        }
    }
    private static func ecdsaSign(curve: String, hash: String, priv: Data, data d: Data) throws -> Data {
        // WebCrypto ECDSA signatures are raw r‖s (IEEE P1363) — CryptoKit's rawRepresentation.
        func go<K>(_ key: K) throws -> Data where K: ECDSASigner {
            switch hash {
            case "SHA-256": return try key.sig(SHA256.hash(data: d))
            case "SHA-384": return try key.sig(SHA384.hash(data: d))
            case "SHA-512": return try key.sig(SHA512.hash(data: d))
            case "SHA-1":   return try key.sig(Insecure.SHA1.hash(data: d))
            default: throw fail("ECDSA hash: \(hash)")
            }
        }
        switch curve {
        case "P-256": return try go(try P256.Signing.PrivateKey(rawRepresentation: priv))
        case "P-384": return try go(try P384.Signing.PrivateKey(rawRepresentation: priv))
        case "P-521": return try go(try P521.Signing.PrivateKey(rawRepresentation: priv))
        default: throw fail("namedCurve: \(curve)")
        }
    }
    private static func ecdsaVerify(curve: String, hash: String, pub: Data, signature: Data, data d: Data) throws -> Bool {
        func go<K>(_ key: K) throws -> Bool where K: ECDSAVerifier {
            switch hash {
            case "SHA-256": return key.ok(signature, SHA256.hash(data: d))
            case "SHA-384": return key.ok(signature, SHA384.hash(data: d))
            case "SHA-512": return key.ok(signature, SHA512.hash(data: d))
            case "SHA-1":   return key.ok(signature, Insecure.SHA1.hash(data: d))
            default: throw fail("ECDSA hash: \(hash)")
            }
        }
        switch curve {
        case "P-256": return try go(try P256.Signing.PublicKey(x963Representation: pub))
        case "P-384": return try go(try P384.Signing.PublicKey(x963Representation: pub))
        case "P-521": return try go(try P521.Signing.PublicKey(x963Representation: pub))
        default: throw fail("namedCurve: \(curve)")
        }
    }
    private static func ecdh(curve: String, priv: Data, pub: Data) throws -> Data {
        switch curve {
        case "P-256":
            let s = try P256.KeyAgreement.PrivateKey(rawRepresentation: priv)
                .sharedSecretFromKeyAgreement(with: P256.KeyAgreement.PublicKey(x963Representation: pub))
            return s.withUnsafeBytes { Data($0) }
        case "P-384":
            let s = try P384.KeyAgreement.PrivateKey(rawRepresentation: priv)
                .sharedSecretFromKeyAgreement(with: P384.KeyAgreement.PublicKey(x963Representation: pub))
            return s.withUnsafeBytes { Data($0) }
        case "P-521":
            let s = try P521.KeyAgreement.PrivateKey(rawRepresentation: priv)
                .sharedSecretFromKeyAgreement(with: P521.KeyAgreement.PublicKey(x963Representation: pub))
            return s.withUnsafeBytes { Data($0) }
        default: throw fail("namedCurve: \(curve)")
        }
    }

    // ── OKP (Ed25519 / X25519) ────────────────────────────────────────────────────────────
    private static func okpImport(_ format: String, keyData: Any?, name: String,
                                  extractable: Bool, usages: [Any]) throws -> Any? {
        let kindName = name == "Ed25519" ? "ed25519" : "x25519"
        let algorithm: [String: Any] = ["name": name]
        switch format {
        case "raw":
            guard let d = data(keyData), d.count == 32 else { throw fail("raw: 32 bytes") }
            return key(kind: kindName, type: "public", material: d, algorithm: algorithm, extractable: extractable, usages: usages)
        case "jwk":
            guard let j = keyData as? [String: Any], str(j["kty"]) == "OKP" else { throw fail("jwk OKP") }
            if let dPart = j["d"], let dd = b64urlDecode(str(dPart)) {
                return key(kind: kindName, type: "private", material: dd, algorithm: algorithm, extractable: extractable, usages: usages)
            }
            guard let x = b64urlDecode(str(j["x"])) else { throw fail("jwk x") }
            return key(kind: kindName, type: "public", material: x, algorithm: algorithm, extractable: extractable, usages: usages)
        default: throw fail("okpImport: raw/jwk")
        }
    }
    private static func okpExport(_ format: String, key k: Any?, material m: Data) throws -> Any? {
        let isPriv = str((k as? [String: Any])?["type"]) == "private"
        let name = str(keyAlg(k)["name"])
        switch format {
        case "raw":
            guard !isPriv else { throw fail("raw export: public keys only") }
            return bytes(m)
        case "jwk":
            if isPriv {
                let pub: Data = name == "Ed25519"
                    ? (try Curve25519.Signing.PrivateKey(rawRepresentation: m)).publicKey.rawRepresentation
                    : (try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: m)).publicKey.rawRepresentation
                return ["kty": "OKP", "crv": name, "x": b64url(pub), "d": b64url(m), "ext": true]
            }
            return ["kty": "OKP", "crv": name, "x": b64url(m), "ext": true]
        default: throw fail("okpExport: raw/jwk")
        }
    }

    // ── RSA (SecKey) — RSASSA-PKCS1-v1_5 · RSA-PSS · RSA-OAEP ────────────────────────────
    private static func rsaGenerate(_ name: String, _ p: [String: Any], extractable: Bool, usages: [Any]) throws -> Any? {
        if let e = p["publicExponent"] as? [Any] {
            let bytesE = e.compactMap { JSE.number($0).map { UInt8(truncatingIfNeeded: Int($0)) } }
            guard bytesE == [1, 0, 1] else { throw fail("publicExponent: 65537 only") }
        }
        let bits = Int(p["modulusLength"].flatMap { JSE.number($0) } ?? 2048)
        let attrs: [String: Any] = [kSecAttrKeyType as String: kSecAttrKeyTypeRSA,
                                    kSecAttrKeySizeInBits as String: bits]
        var error: Unmanaged<CFError>?
        guard let priv = SecKeyCreateRandomKey(attrs as CFDictionary, &error),
              let pub = SecKeyCopyPublicKey(priv),
              let privPKCS1 = SecKeyCopyExternalRepresentation(priv, &error) as Data?,
              let pubPKCS1 = SecKeyCopyExternalRepresentation(pub, &error) as Data?
        else { throw fail("RSA generate: \(error.map { "\($0.takeRetainedValue())" } ?? "?")") }
        let algorithm: [String: Any] = ["name": rsaPretty(name), "modulusLength": Double(bits),
                                        "publicExponent": [Double(1), Double(0), Double(1)],
                                        "hash": ["name": hashName(p["hash"] ?? "SHA-256")]]
        return ["publicKey":  key(kind: "rsa-pub",  type: "public",  material: pubPKCS1,  algorithm: algorithm, extractable: true, usages: usages),
                "privateKey": key(kind: "rsa-priv", type: "private", material: privPKCS1, algorithm: algorithm, extractable: extractable, usages: usages)]
    }
    private static func rsaPretty(_ upper: String) -> String {
        switch upper {
        case "RSASSA-PKCS1-V1_5": return "RSASSA-PKCS1-v1_5"
        default: return upper                      // RSA-PSS / RSA-OAEP are already canonical
        }
    }
    private static func rsaImport(_ format: String, keyData: Any?, alg: Any?, extractable: Bool, usages: [Any]) throws -> Any? {
        let name = rsaPretty(algName(alg))
        let algorithm: [String: Any] = ["name": name, "hash": ["name": hashName(alg)]]
        switch format {
        case "spki":
            guard let d = data(keyData) else { throw fail("spki data") }
            let pkcs1 = try derUnwrapSPKI(d)
            _ = try rsaSecKey(pkcs1, isPrivate: false)           // validate
            return key(kind: "rsa-pub", type: "public", material: pkcs1, algorithm: algorithm, extractable: extractable, usages: usages)
        case "pkcs8":
            guard let d = data(keyData) else { throw fail("pkcs8 data") }
            let pkcs1 = try derUnwrapPKCS8(d)
            _ = try rsaSecKey(pkcs1, isPrivate: true)
            return key(kind: "rsa-priv", type: "private", material: pkcs1, algorithm: algorithm, extractable: extractable, usages: usages)
        case "jwk":
            guard let j = keyData as? [String: Any], str(j["kty"]) == "RSA",
                  let n = b64urlDecode(str(j["n"])), let e = b64urlDecode(str(j["e"])) else { throw fail("jwk RSA") }
            if j["d"] != nil {
                let parts = ["n", "e", "d", "p", "q", "dp", "dq", "qi"].map { b64urlDecode(str(j[$0])) }
                guard !parts.contains(where: { $0 == nil }) else { throw fail("jwk RSA private: full CRT set required") }
                let ints = [Data([0])] + parts.map { $0! }       // version 0 ‖ n e d p q dp dq qi
                let pkcs1 = derSequence(ints.map { derInteger($0) }.reduce(Data(), +))
                _ = try rsaSecKey(pkcs1, isPrivate: true)
                return key(kind: "rsa-priv", type: "private", material: pkcs1, algorithm: algorithm, extractable: extractable, usages: usages)
            }
            let pkcs1 = derSequence(derInteger(n) + derInteger(e))
            _ = try rsaSecKey(pkcs1, isPrivate: false)
            return key(kind: "rsa-pub", type: "public", material: pkcs1, algorithm: algorithm, extractable: extractable, usages: usages)
        default: throw fail("rsaImport: spki/pkcs8/jwk")
        }
    }
    private static func rsaExport(_ format: String, key k: Any?, material pkcs1: Data) throws -> Any? {
        let isPriv = kind(k) == "rsa-priv"
        switch format {
        case "spki":
            guard !isPriv else { throw fail("spki: public keys only") }
            return bytes(derWrapSPKI(pkcs1))
        case "pkcs8":
            guard isPriv else { throw fail("pkcs8: private keys only") }
            return bytes(derWrapPKCS8(pkcs1))
        case "jwk":
            var ints = try derReadIntegers(pkcs1)
            if isPriv {
                guard ints.count >= 9 else { throw fail("pkcs1 private shape") }
                ints.removeFirst()                                // version
                let names = ["n", "e", "d", "p", "q", "dp", "dq", "qi"]
                var j: [String: Any] = ["kty": "RSA", "ext": true]
                for (i, nm) in names.enumerated() { j[nm] = b64url(ints[i]) }
                return j
            }
            guard ints.count >= 2 else { throw fail("pkcs1 public shape") }
            return ["kty": "RSA", "n": b64url(ints[0]), "e": b64url(ints[1]), "ext": true]
        default: throw fail("rsaExport: spki/pkcs8/jwk")
        }
    }
    private static func rsaSecKey(_ pkcs1: Data, isPrivate: Bool) throws -> SecKey {
        let attrs: [String: Any] = [kSecAttrKeyType as String: kSecAttrKeyTypeRSA,
                                    kSecAttrKeyClass as String: isPrivate ? kSecAttrKeyClassPrivate : kSecAttrKeyClassPublic]
        var error: Unmanaged<CFError>?
        guard let k = SecKeyCreateWithData(pkcs1 as CFData, attrs as CFDictionary, &error)
        else { throw fail("SecKeyCreateWithData: \(error.map { "\($0.takeRetainedValue())" } ?? "?")") }
        return k
    }
    private static func rsaAlgorithm(_ name: String, hash: String, sign: Bool) throws -> SecKeyAlgorithm {
        switch (name, hash, sign) {
        case ("RSASSA-PKCS1-V1_5", "SHA-1", true):   return .rsaSignatureMessagePKCS1v15SHA1
        case ("RSASSA-PKCS1-V1_5", "SHA-256", true): return .rsaSignatureMessagePKCS1v15SHA256
        case ("RSASSA-PKCS1-V1_5", "SHA-384", true): return .rsaSignatureMessagePKCS1v15SHA384
        case ("RSASSA-PKCS1-V1_5", "SHA-512", true): return .rsaSignatureMessagePKCS1v15SHA512
        case ("RSA-PSS", "SHA-1", true):             return .rsaSignatureMessagePSSSHA1
        case ("RSA-PSS", "SHA-256", true):           return .rsaSignatureMessagePSSSHA256
        case ("RSA-PSS", "SHA-384", true):           return .rsaSignatureMessagePSSSHA384
        case ("RSA-PSS", "SHA-512", true):           return .rsaSignatureMessagePSSSHA512
        case ("RSA-OAEP", "SHA-1", false):           return .rsaEncryptionOAEPSHA1
        case ("RSA-OAEP", "SHA-256", false):         return .rsaEncryptionOAEPSHA256
        case ("RSA-OAEP", "SHA-384", false):         return .rsaEncryptionOAEPSHA384
        case ("RSA-OAEP", "SHA-512", false):         return .rsaEncryptionOAEPSHA512
        default: throw fail("RSA: \(name)+\(hash)")
        }
    }
    private static func hashByteLength(_ hash: String) -> Int {
        switch hash { case "SHA-1": return 20; case "SHA-384": return 48; case "SHA-512": return 64; default: return 32 }
    }
    private static func rsaSign(_ name: String, hash: String, alg: Any?, key k: Any?, data d: Data) throws -> Data {
        if name == "RSA-PSS", let s = algDict(alg)["saltLength"].flatMap({ JSE.number($0) }),
           Int(s) != hashByteLength(hash) { throw fail("RSA-PSS saltLength: must equal hash length (SecKey)") }
        let sk = try rsaSecKey(try material(k), isPrivate: true)
        var error: Unmanaged<CFError>?
        guard let sig = SecKeyCreateSignature(sk, try rsaAlgorithm(name, hash: hash, sign: true), d as CFData, &error) as Data?
        else { throw fail("RSA sign: \(error.map { "\($0.takeRetainedValue())" } ?? "?")") }
        return sig
    }
    private static func rsaVerify(_ name: String, hash: String, alg: Any?, key k: Any?, signature: Data, data d: Data) throws -> Bool {
        if name == "RSA-PSS", let s = algDict(alg)["saltLength"].flatMap({ JSE.number($0) }),
           Int(s) != hashByteLength(hash) { throw fail("RSA-PSS saltLength: must equal hash length (SecKey)") }
        let pk = try rsaSecKey(try material(k), isPrivate: false)
        var error: Unmanaged<CFError>?
        return SecKeyVerifySignature(pk, try rsaAlgorithm(name, hash: hash, sign: true), d as CFData, signature as CFData, &error)
    }
    private static func rsaCrypt(encrypt: Bool, hash: String, key k: Any?, data d: Data) throws -> Data {
        let sk = try rsaSecKey(try material(k), isPrivate: !encrypt)
        let algo = try rsaAlgorithm("RSA-OAEP", hash: hash, sign: false)
        var error: Unmanaged<CFError>?
        let out = encrypt
            ? SecKeyCreateEncryptedData(sk, algo, d as CFData, &error)
            : SecKeyCreateDecryptedData(sk, algo, d as CFData, &error)
        guard let out = out as Data? else { throw fail("RSA-OAEP: \(error.map { "\($0.takeRetainedValue())" } ?? "?")") }
        return out
    }

    // ── minimal DER (just enough for RSA SPKI/PKCS#8 ↔ PKCS#1 and JWK ints) ───────────────
    private static let rsaOIDAlgId = Data([0x30, 0x0D, 0x06, 0x09, 0x2A, 0x86, 0x48, 0x86,
                                           0xF7, 0x0D, 0x01, 0x01, 0x01, 0x05, 0x00])   // SEQ{ OID rsaEncryption, NULL }
    private static func derLength(_ n: Int) -> Data {
        if n < 0x80 { return Data([UInt8(n)]) }
        var v = n, out = Data()
        while v > 0 { out.insert(UInt8(v & 0xFF), at: 0); v >>= 8 }
        return Data([0x80 | UInt8(out.count)]) + out
    }
    private static func derTag(_ tag: UInt8, _ content: Data) -> Data { Data([tag]) + derLength(content.count) + content }
    private static func derSequence(_ content: Data) -> Data { derTag(0x30, content) }
    private static func derInteger(_ raw: Data) -> Data {
        var v = raw
        while v.count > 1, v.first == 0 { v.removeFirst() }            // minimal form
        if let f = v.first, f & 0x80 != 0 { v.insert(0, at: v.startIndex) }  // keep positive
        return derTag(0x02, v)
    }
    private static func derWrapSPKI(_ pkcs1: Data) -> Data {
        derSequence(rsaOIDAlgId + derTag(0x03, Data([0]) + pkcs1))     // BIT STRING, 0 unused bits
    }
    private static func derWrapPKCS8(_ pkcs1: Data) -> Data {
        derSequence(derInteger(Data([0])) + rsaOIDAlgId + derTag(0x04, pkcs1))
    }
    /// One TLV step: returns (tag, content range start, content length, next index).
    private static func derStep(_ d: Data, _ i: Int) throws -> (tag: UInt8, start: Int, len: Int, next: Int) {
        guard i + 1 < d.count else { throw fail("der: truncated") }
        let tag = d[d.startIndex + i]
        var p = i + 1
        var len = Int(d[d.startIndex + p]); p += 1
        if len & 0x80 != 0 {
            let n = len & 0x7F
            guard n > 0, n <= 4, p + n <= d.count else { throw fail("der: length") }
            len = 0
            for _ in 0..<n { len = (len << 8) | Int(d[d.startIndex + p]); p += 1 }
        }
        guard p + len <= d.count else { throw fail("der: overrun") }
        return (tag, p, len, p + len)
    }
    private static func derUnwrapSPKI(_ d: Data) throws -> Data {
        let outer = try derStep(d, 0)
        guard outer.tag == 0x30 else { throw fail("spki: SEQUENCE") }
        let algId = try derStep(d, outer.start)                         // AlgorithmIdentifier (skip)
        let bits = try derStep(d, algId.next)
        guard bits.tag == 0x03, bits.len > 1 else { throw fail("spki: BIT STRING") }
        return d.subdata(in: (d.startIndex + bits.start + 1)..<(d.startIndex + bits.start + bits.len))
    }
    private static func derUnwrapPKCS8(_ d: Data) throws -> Data {
        let outer = try derStep(d, 0)
        guard outer.tag == 0x30 else { throw fail("pkcs8: SEQUENCE") }
        let version = try derStep(d, outer.start)                       // INTEGER 0
        let algId = try derStep(d, version.next)                        // AlgorithmIdentifier (skip)
        let octets = try derStep(d, algId.next)
        guard octets.tag == 0x04 else { throw fail("pkcs8: OCTET STRING") }
        return d.subdata(in: (d.startIndex + octets.start)..<(d.startIndex + octets.start + octets.len))
    }
    /// All INTEGERs of a PKCS#1 SEQUENCE, leading zero stripped (for JWK b64url parts).
    private static func derReadIntegers(_ d: Data) throws -> [Data] {
        let outer = try derStep(d, 0)
        guard outer.tag == 0x30 else { throw fail("pkcs1: SEQUENCE") }
        var out: [Data] = []
        var i = outer.start
        while i < outer.start + outer.len {
            let t = try derStep(d, i)
            guard t.tag == 0x02 else { break }
            var v = d.subdata(in: (d.startIndex + t.start)..<(d.startIndex + t.start + t.len))
            while v.count > 1, v.first == 0 { v.removeFirst() }
            out.append(v)
            i = t.next
        }
        return out
    }
}

/// Tiny protocol shims so ECDSA sign/verify stay generic over P-256/384/521 without
/// repeating the per-curve digest matrix three times.
private protocol ECDSASigner { func sig<D: Digest>(_ digest: D) throws -> Data }
private protocol ECDSAVerifier { func ok<D: Digest>(_ signature: Data, _ digest: D) -> Bool }
extension P256.Signing.PrivateKey: ECDSASigner {
    fileprivate func sig<D: Digest>(_ digest: D) throws -> Data { try signature(for: digest).rawRepresentation }
}
extension P384.Signing.PrivateKey: ECDSASigner {
    fileprivate func sig<D: Digest>(_ digest: D) throws -> Data { try signature(for: digest).rawRepresentation }
}
extension P521.Signing.PrivateKey: ECDSASigner {
    fileprivate func sig<D: Digest>(_ digest: D) throws -> Data { try signature(for: digest).rawRepresentation }
}
extension P256.Signing.PublicKey: ECDSAVerifier {
    fileprivate func ok<D: Digest>(_ signature: Data, _ digest: D) -> Bool {
        (try? P256.Signing.ECDSASignature(rawRepresentation: signature)).map { isValidSignature($0, for: digest) } ?? false
    }
}
extension P384.Signing.PublicKey: ECDSAVerifier {
    fileprivate func ok<D: Digest>(_ signature: Data, _ digest: D) -> Bool {
        (try? P384.Signing.ECDSASignature(rawRepresentation: signature)).map { isValidSignature($0, for: digest) } ?? false
    }
}
extension P521.Signing.PublicKey: ECDSAVerifier {
    fileprivate func ok<D: Digest>(_ signature: Data, _ digest: D) -> Bool {
        (try? P521.Signing.ECDSASignature(rawRepresentation: signature)).map { isValidSignature($0, for: digest) } ?? false
    }
}

// MARK: - JSE · JS core globals (1:1) — URL · Date · Intl · JSON · Math · Blob/FormData · Abort
//
// The boring, universal web/JS primitives that make JSE computationally complete for APP
// LOGIC — verbatim syntax, no JS engine, native under the hood (Foundation). The rule:
// CORE makes app logic portable; PACKAGES make device capabilities possible. So URL math,
// dates, number/date formatting, JSON, encoding, multipart bodies and async orchestration
// live here — camera/auth/payments/location stay packages.
//
//   new URL('/checkout?plan=pro', base) · url.searchParams.get('plan') · url.searchParams.set(…)
//   new Headers({ … }) · new Request(url, opts) · res.json() / res.text() / res.headers.get(…)
//   new Blob([…], { type }) · new File([…], name, { type }) · new FormData() + form.append(…)
//   Date.now() · new Date(iso).getTime() · date.toISOString() · date.getFullYear() …
//   new Intl.NumberFormat('en-US', { style:'currency', currency:'USD' }).format(9.99)
//   new Intl.DateTimeFormat('fr-FR', { dateStyle:'medium' }).format(d) · Intl.RelativeTimeFormat
//   JSON.stringify / JSON.parse · encodeURIComponent / decodeURIComponent / encodeURI / decodeURI
//   Math.floor/ceil/round/abs/min/max/pow/sqrt/random/… · Math.PI · parseInt/parseFloat/isNaN
//   structuredClone(x) · new AbortController() → fetch(url, { signal }) … c.abort()
//   await Promise.all([ fetch(a), fetch(b), dsx.module.x.y({…}) ]) · race · any · allSettled
//
// Value semantics throughout: objects are dicts with internal "__" marker fields (a URL is
// { __url, href, pathname, searchParams, … }), so they store in dsx.variable.*, serialize, and
// cross surfaces. Mutating methods (searchParams.set, form.append, headers.set, c.abort) are
// STATEMENTS — the runner reads, mutates, writes back (the array-push pattern); in expression
// position they return the modified copy. Timers (setTimeout/setInterval, keyed) were already
// first-class. Total like all of JSE: bad input logs `[JSE core]` and yields null.

enum JSECore {
    /// The host's platform-idiom probe — installed at app boot (DSXBoot, next to the
    /// JSE.appVars/envChannel seams) because THIS file is UIKit-free by rule (it rides
    /// satellite-node targets): `{ UIDevice.current.userInterfaceIdiom == .pad ? "iPad"
    /// : "iPhone" }`. Un-installed (a snapshot extension) falls back to "iPhone".
    static var platformName: (() -> String)?

    // ── routing ────────────────────────────────────────────────────────────────────────────
    static func handles(_ name: String) -> Bool {
        if name.hasPrefix("Math.") || name.hasPrefix("Intl.") || name.hasPrefix("JSON.")
            || name.hasPrefix("Date.") || name.hasPrefix("Promise.")
            || name.hasPrefix("Object.") || name.hasPrefix("console.")
            || name.hasPrefix("performance.") { return true }
        switch name {
        case "URL", "URLSearchParams", "Headers", "Request", "Blob", "File", "FormData",
             "Date", "AbortController", "structuredClone",
             "encodeURIComponent", "decodeURIComponent", "encodeURI", "decodeURI",
             "parseInt", "parseFloat", "isNaN", "Number", "String", "Boolean",
             "Map", "Set", "Error", "RegExp", "WebSocket":
            return true
        default: return false
        }
    }

    static func call(_ name: String, _ a: [Any?]) -> Any? {
        func arg(_ i: Int) -> Any? { i < a.count ? a[i] : nil }
        func str(_ i: Int) -> String { JSE.string(arg(i)) }
        if name.hasPrefix("Math.") { return math(String(name.dropFirst(5)), a) }
        switch name {
        // ── URL / URLSearchParams ──
        case "URL":
            let baseHref: String? = (arg(1) as? [String: Any]).flatMap { $0["href"] as? String } ?? (arg(1) as? String)
            guard let u = makeURL(str(0), base: baseHref) else { NSLog("[JSE core] URL: invalid '%@'", str(0)); return nil }
            return u
        case "URLSearchParams":
            return ["__params": parseParams(arg(0))]
        // ── fetch companions ──
        case "Headers":
            var h: [String: Any] = ["__headers": true]
            if let src = arg(0) as? [String: Any] { for (k, v) in src where !k.hasPrefix("__") { h[k.lowercased()] = JSE.string(v) } }
            return h
        case "Request":
            var r: [String: Any] = ["__request": true, "url": "", "method": "GET"]
            if let u = arg(0) as? [String: Any], let href = u["href"] as? String { r["url"] = href } else { r["url"] = str(0) }
            if let opts = arg(1) as? [String: Any] {
                if let m = opts["method"] { r["method"] = JSE.string(m) }
                if let h = opts["headers"] { r["headers"] = h }
                if let b = opts["body"] { r["body"] = b }
                if let sig = opts["signal"] { r["signal"] = sig }
            }
            return r
        // ── Blob / File / FormData ──
        case "Blob", "File":
            let parts = (arg(0) as? [Any]) ?? []
            var data = Data()
            for p in parts {
                if let d = blobData(p) { data.append(d) }
                else if let bytes = JSECrypto.data(p) { data.append(bytes) }
            }
            let optsIdx = name == "File" ? 2 : 1
            let opts = (arg(optsIdx) as? [String: Any]) ?? [:]
            var blob: [String: Any] = ["__blob": data.base64EncodedString(),
                                       "type": JSE.string(opts["type"] ?? ""), "size": Double(data.count)]
            if name == "File" {
                blob["name"] = str(1)
                blob["lastModified"] = (opts["lastModified"].flatMap { JSE.number($0) }) ?? Date().timeIntervalSince1970 * 1000
            }
            return blob
        case "FormData":
            return ["__formdata": [Any]()]
        // ── Date ──
        case "Date":
            if a.isEmpty { return ["__date": Date().timeIntervalSince1970 * 1000] }
            if a.count >= 2 { return ["__date": dateFromComponents(a)] }
            return ["__date": parseDateMS(arg(0))]
        case "Date.now":   return Date().timeIntervalSince1970 * 1000
        case "Date.parse": return parseDateMS(arg(0))
        case "Date.UTC":
            // any non-finite provided arg → nil (the TS twin's NaN-ms → null); components
            // ride the calendar clamp — Int(∞/NaN/1e30) would TRAP on author input (F20)
            for v in a { if let n = JSE.number(v), !n.isFinite { return nil } }
            func nn(_ i: Int, _ def: Double) -> Double { JSE.number(arg(i)) ?? def }
            var ucal = Calendar(identifier: .gregorian)
            ucal.timeZone = TimeZone(identifier: "UTC") ?? .current
            var comps = DateComponents()
            comps.year = calInt(nn(0, 1970)); comps.month = 1; comps.day = 1
            guard var d0 = ucal.date(from: comps) else { return nil }
            d0 = ucal.date(byAdding: .month, value: calInt(nn(1, 0)), to: d0) ?? d0
            d0 = ucal.date(byAdding: .day, value: calInt(nn(2, 1)) - 1, to: d0) ?? d0
            d0 = d0.addingTimeInterval(nn(3, 0) * 3600 + nn(4, 0) * 60 + nn(5, 0) + nn(6, 0) / 1000)
            return (d0.timeIntervalSince1970 * 1000).rounded()
        // ── Intl ──
        case "Intl.NumberFormat":
            return ["__numfmt": true, "locale": str(0), "options": (arg(1) as? [String: Any]) ?? [:]]
        case "Intl.DateTimeFormat":
            return ["__datefmt": true, "locale": str(0), "options": (arg(1) as? [String: Any]) ?? [:]]
        case "Intl.RelativeTimeFormat":
            return ["__relfmt": true, "locale": str(0), "options": (arg(1) as? [String: Any]) ?? [:]]
        // ── JSON / encoding ──
        case "JSON.stringify":
            let v = jsonSanitize(arg(0) ?? NSNull())
            var opts: JSONSerialization.WritingOptions = [.fragmentsAllowed]
            if let space = arg(2).flatMap({ JSE.number($0) }), space > 0 { opts.insert(.prettyPrinted) }
            guard let d = try? JSONSerialization.data(withJSONObject: v, options: opts) else { return nil }
            return String(decoding: d, as: UTF8.self)
        case "JSON.parse":
            guard let obj = try? JSONSerialization.jsonObject(with: Data(str(0).utf8), options: [.fragmentsAllowed])
            else { NSLog("[JSE core] JSON.parse: invalid"); return nil }
            return obj
        case "encodeURIComponent": return percentEncode(str(0), keep: "-_.!~*'()")
        case "encodeURI":          return percentEncode(str(0), keep: "-_.!~*'();/?:@&=+$,#")
        case "decodeURIComponent", "decodeURI": return str(0).removingPercentEncoding ?? str(0)
        // ── Object helpers ──
        case "Object.keys":    return ((arg(0) as? [String: Any]).map { Array($0.keys.filter { !$0.hasPrefix("__") }) }) ?? [Any]()
        case "Object.values":
            guard let d = arg(0) as? [String: Any] else { return [Any]() }
            return d.filter { !$0.key.hasPrefix("__") }.map { $0.value }
        case "Object.entries":
            guard let d = arg(0) as? [String: Any] else { return [Any]() }
            return d.filter { !$0.key.hasPrefix("__") }.map { [$0.key, $0.value] as [Any] }
        case "Object.assign":      // value semantics: returns the MERGED dict (use x = Object.assign({}, x, y))
            var out: [String: Any] = [:]
            for src in a { if let d = src as? [String: Any] { out.merge(d) { _, new in new } } }
            return out
        case "Object.hasOwn":
            return ((arg(0) as? [String: Any])?[JSE.string(arg(1))]) != nil
        case "Object.fromEntries":
            var out: [String: Any] = [:]
            let entries = (arg(0) as? [String: Any])?["__map"] as? [Any] ?? (arg(0) as? [Any]) ?? []
            for e in entries { if let pair = e as? [Any], let k = pair.first { out[JSE.string(k)] = pair.count > 1 ? pair[1] : NSNull() } }
            return out
        // ── console (NSLog + the ring buffer the debugger reads) ──
        case "console.log", "console.info", "console.debug", "console.warn", "console.error":
            let level = String(name.dropFirst(8))
            let line = JSELogFormat.args(a)   // the house formatter (logs corpus)
            // the unified log ring (dsx.logs / the dev drawer) sees console.* too — the
            // builtin has no scheme of its own, so entries attribute as "console"
            DSXLogBuffer.shared.append(DSXLogEntry(scheme: "console", level: level, message: line))
            JSEConsole.shared.append(level: level, line)
            return nil
        // ── Map / Set (value objects; add/set/delete are statements, like the rest) ──
        case "Map":
            var entries: [Any] = []
            if let init0 = arg(0) as? [Any] {
                for e in init0 { if let pair = e as? [Any], pair.count >= 2 { entries.append([pair[0], pair[1]]) } }
            }
            return ["__map": entries, "size": Double(entries.count)]
        case "Set":
            var values: [Any] = []
            if let init0 = arg(0) as? [Any] {
                for v in init0 where !values.contains(where: { JSE.equals($0, v) }) { values.append(v) }
            }
            return ["__set": values, "size": Double(values.count)]
        case "WebSocket":
            NSLog("[JSE core] WebSocket is statement-only: const ws = new WebSocket(url[, { key }]) in an action body")
            return nil
        // ── RegExp (the literal form /…/flags tokenizes to the same value) ──
        case "RegExp":
            return ["__regex": true, "source": str(0), "flags": str(1)]
        // ── timing + errors ──
        case "performance.now":    return ProcessInfo.processInfo.systemUptime * 1000
        case "Error":              return ["__error": true, "name": "Error", "message": JSE.string(arg(0))]
        // ── misc globals ──
        case "structuredClone":    return deepCopy(arg(0))
        case "AbortController":
            let id = UUID().uuidString
            return ["__controller": id, "signal": ["__signal": id, "aborted": false]]
        case "parseInt":
            let radix = arg(1).flatMap { JSE.number($0) }.map(Int.init)
            return parseIntJS(str(0), radix: radix)
        case "parseFloat":
            var s = str(0).trimmingCharacters(in: .whitespaces)
            var head = ""
            for ch in s { if ch.isNumber || ch == "." || ch == "-" || ch == "+" || ch == "e" || ch == "E" { head.append(ch) } else { break } }
            s = head
            return Double(s) ?? Double.nan
        case "isNaN":   return (JSE.number(arg(0)) ?? Double.nan).isNaN
        case "Number":  return JSE.number(arg(0)) ?? Double.nan
        case "String":  return JSE.string(arg(0))
        case "Boolean": return JSE.truthy(arg(0))
        default:
            if name.hasPrefix("Promise.") {
                NSLog("[JSE core] %@ is await-only: use `await %@([ … ])` as a statement", name, name)
                return nil
            }
            return nil
        }
    }

    /// Constants the evaluator can't reach as calls (bare member reads on a namespace).
    static func constant(_ id: String) -> Any? {
        switch id {
        case "Math.PI": return Double.pi
        case "Math.E":  return M_E
        case "Number.MAX_SAFE_INTEGER": return 9007199254740991.0
        case "Number.MIN_SAFE_INTEGER": return -9007199254740991.0
        case "Number.EPSILON": return Double.ulpOfOne
        case "Infinity": return Double.infinity
        case "NaN": return Double.nan
        // navigator — the read-only METADATA subset (capabilities stay packages)
        case "navigator.language":  return Locale.preferredLanguages.first ?? "en"
        case "navigator.languages": return Locale.preferredLanguages
        case "navigator.platform":
            // UIKit-free file: the idiom probe is a boot-installed seam (declared above).
            #if os(watchOS)
            return "Apple Watch"
            #else
            return platformName?() ?? "iPhone"
            #endif
        case "navigator.onLine":    return JSEReachability.shared.onLine
        default: return nil
        }
    }

    private static func math(_ fn: String, _ a: [Any?]) -> Any? {
        let nums = a.map { JSE.number($0) ?? Double.nan }
        func n(_ i: Int) -> Double { i < nums.count ? nums[i] : Double.nan }
        switch fn {
        case "floor":  return n(0).rounded(.down)
        case "ceil":   return n(0).rounded(.up)
        case "round":  return (n(0) + 0.5).rounded(.down)          // JS half-up (incl. negatives)
        case "trunc":  return n(0).rounded(.towardZero)
        case "abs":    return Swift.abs(n(0))
        case "sign":   return n(0) == 0 ? 0 : (n(0) > 0 ? 1 : -1)
        case "min":    return nums.min() ?? Double.infinity
        case "max":    return nums.max() ?? -Double.infinity
        case "pow":    return Foundation.pow(n(0), n(1))
        case "sqrt":   return n(0) < 0 ? Double.nan : n(0).squareRoot()
        case "cbrt":   return Foundation.cbrt(n(0))
        case "hypot":  return Foundation.hypot(n(0), n(1))
        case "atan":   return Foundation.atan(n(0))
        case "asin":   return Foundation.asin(n(0))
        case "acos":   return Foundation.acos(n(0))
        case "sinh":   return Foundation.sinh(n(0))
        case "cosh":   return Foundation.cosh(n(0))
        case "tanh":   return Foundation.tanh(n(0))
        case "asinh":  return Foundation.asinh(n(0))
        case "acosh":  return Foundation.acosh(n(0))
        case "atanh":  return Foundation.atanh(n(0))
        case "log1p":  return Foundation.log1p(n(0))
        case "expm1":  return Foundation.expm1(n(0))
        case "fround": return Double(Float(n(0)))
        case "clz32":
            let x = n(0)
            var u: Double = 0
            if x.isFinite {
                u = (x < 0 ? x.rounded(.up) : x.rounded(.down)).truncatingRemainder(dividingBy: 4294967296.0)
                if u < 0 { u += 4294967296.0 }
            }
            return Double(UInt32(u).leadingZeroBitCount)
        case "imul":
            func i32(_ x: Double) -> Int32 {
                guard x.isFinite else { return 0 }
                var tt = (x < 0 ? x.rounded(.up) : x.rounded(.down)).truncatingRemainder(dividingBy: 4294967296.0)
                if tt >= 2147483648.0 { tt -= 4294967296.0 } else if tt < -2147483648.0 { tt += 4294967296.0 }
                return Int32(tt)
            }
            return Double(i32(n(0)) &* i32(n(1)))
        case "random": return Double.random(in: 0..<1)
        case "log":    return Foundation.log(n(0))
        case "log2":   return Foundation.log2(n(0))
        case "log10":  return Foundation.log10(n(0))
        case "exp":    return Foundation.exp(n(0))
        case "sin":    return Foundation.sin(n(0))
        case "cos":    return Foundation.cos(n(0))
        case "tan":    return Foundation.tan(n(0))
        case "atan2":  return Foundation.atan2(n(0), n(1))
        default:       return nil
        }
    }

    // ── methods on JS-core dict shapes (expression position) ─────────────────────────────
    /// applyMethod's first stop. Returns nil = "not mine" (plain values fall through to the
    /// generic string/array methods); `Handled(value:)` = the method's result (which may be null).
    struct Handled { let value: Any? }
    static func method(_ m: String, _ base: Any?, _ a: [Any?]) -> Handled? {
        guard let d = base as? [String: Any] else { return nil }
        func arg(_ i: Int) -> Any? { i < a.count ? a[i] : nil }
        func str(_ i: Int) -> String { JSE.string(arg(i)) }
        // URLSearchParams / FormData (entries lists)
        if let entries = d["__params"] as? [Any] ?? d["__formdata"] as? [Any] {
            let isParams = d["__params"] != nil
            switch m {
            case "get":    return Handled(value: entries.compactMap { $0 as? [Any] }.first { JSE.string($0.first) == str(0) }?.last)
            case "getAll": return Handled(value: entries.compactMap { $0 as? [Any] }.filter { JSE.string($0.first) == str(0) }.compactMap { $0.last })
            case "has":    return Handled(value: entries.compactMap { $0 as? [Any] }.contains { JSE.string($0.first) == str(0) })
            case "toString":
                guard isParams else { return Handled(value: "[object FormData]") }
                return Handled(value: encodeParams(entries))
            case "set", "append", "delete":      // expression position → the modified COPY (statement form persists)
                var v: Any = d
                mutate(m, &v, args: a.map { $0 })
                return Handled(value: v)
            default: return nil
            }
        }
        // RegExp — re.test(s) (string-side match/replace/split live on applyMethod's string cases)
        if d["__regex"] != nil, m == "test" {
            return Handled(value: JSERegex.test(JSE.string(arg(0)), d))
        }
        // Map / Set (value objects — get/has read; set/add/delete return modified copies here,
        // and PERSIST in statement form via the runner's mutation hook)
        if let mapEntries = d["__map"] as? [Any] {
            switch m {
            case "get": return Handled(value: mapEntries.compactMap { $0 as? [Any] }.first { JSE.equals($0.first, arg(0)) }?.last)
            case "has": return Handled(value: mapEntries.compactMap { $0 as? [Any] }.contains { JSE.equals($0.first, arg(0)) })
            case "set", "delete":
                var v: Any = d
                mutate(m, &v, args: a)
                return Handled(value: v)
            default: return nil
            }
        }
        if let setValues = d["__set"] as? [Any] {
            switch m {
            case "has": return Handled(value: setValues.contains { JSE.equals($0, arg(0)) })
            case "add", "delete":
                var v: Any = d
                mutate(m, &v, args: a)
                return Handled(value: v)
            default: return nil
            }
        }
        // Headers (plain lowercased keys + marker)
        if d["__headers"] != nil {
            switch m {
            case "get":  return Handled(value: d[str(0)] ?? d[str(0).lowercased()])
            case "has":  return Handled(value: (d[str(0)] ?? d[str(0).lowercased()]) != nil)
            case "set", "append", "delete":
                var v: Any = d
                mutate(m, &v, args: a.map { $0 })
                return Handled(value: v)
            default: return nil
            }
        }
        // fetch result (Response-shaped)
        if d["__response"] != nil {
            switch m {
            case "json": return Handled(value: d["data"])
            case "text": return Handled(value: d["text"] ?? "")
            default: return nil
            }
        }
        // Date
        if let ms = d["__date"] as? Double {
            let date = Date(timeIntervalSince1970: ms / 1000)
            var cal = Calendar(identifier: .gregorian)
            cal.timeZone = TimeZone.current                      // JS getters are LOCAL time
            let comp = cal.dateComponents([.year, .month, .day, .weekday, .hour, .minute, .second, .nanosecond], from: date)
            switch m {
            case "getTime", "valueOf": return Handled(value: ms)
            case "toISOString", "toJSON":
                let f = ISO8601DateFormatter()
                f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
                f.timeZone = TimeZone(identifier: "UTC")
                return Handled(value: f.string(from: date))
            case "toString":           return Handled(value: stringCoerce(d) ?? "")
            case "getFullYear":        return Handled(value: Double(comp.year ?? 0))
            case "getMonth":           return Handled(value: Double((comp.month ?? 1) - 1))   // 0-based, like JS
            case "getDate":            return Handled(value: Double(comp.day ?? 0))
            case "getDay":             return Handled(value: Double(((comp.weekday ?? 1) - 1)))  // 0 = Sunday
            case "getHours":           return Handled(value: Double(comp.hour ?? 0))
            case "getMinutes":         return Handled(value: Double(comp.minute ?? 0))
            case "getSeconds":         return Handled(value: Double(comp.second ?? 0))
            case "getMilliseconds":    return Handled(value: Double((comp.nanosecond ?? 0) / 1_000_000))
            case "getUTCFullYear":     return Handled(value: Double(utcComponents(date).year ?? 0))
            case "getUTCMonth":        return Handled(value: Double((utcComponents(date).month ?? 1) - 1))
            case "getUTCDate":         return Handled(value: Double(utcComponents(date).day ?? 0))
            case "getUTCDay":          return Handled(value: Double((utcComponents(date).weekday ?? 1) - 1))
            case "getUTCHours":        return Handled(value: Double(utcComponents(date).hour ?? 0))
            case "getUTCMinutes":      return Handled(value: Double(utcComponents(date).minute ?? 0))
            case "getUTCSeconds":      return Handled(value: Double(utcComponents(date).second ?? 0))
            case "getUTCMilliseconds": return Handled(value: Double((utcComponents(date).nanosecond ?? 0) / 1_000_000))
            case "getTimezoneOffset":  return Handled(value: Double(-TimeZone.current.secondsFromGMT(for: date) / 60))
            case "setTime", "setFullYear", "setMonth", "setDate", "setHours",
                 "setMinutes", "setSeconds", "setMilliseconds":
                // expression position returns the new ms; the STATEMENT route persists it
                // through mutate() — the value-object mutation contract.
                return Handled(value: dateSetMS(ms, m, a))
            case "toLocaleDateString", "toLocaleTimeString", "toLocaleString":
                let f = DateFormatter()
                if let loc = arg(0) as? String, !loc.isEmpty { f.locale = Locale(identifier: loc) }
                f.dateStyle = m == "toLocaleTimeString" ? .none : .medium
                f.timeStyle = m == "toLocaleDateString" ? .none : (m == "toLocaleTimeString" ? .medium : .short)
                return Handled(value: f.string(from: date))
            default: return nil
            }
        }
        // Intl formatters
        if d["__numfmt"] != nil, m == "format" {
            return Handled(value: formatNumber(JSE.number(arg(0)) ?? Double.nan,
                                               locale: JSE.string(d["locale"]), options: (d["options"] as? [String: Any]) ?? [:]))
        }
        if d["__datefmt"] != nil, m == "format" {
            let ms = (arg(0) as? [String: Any])?["__date"] as? Double ?? JSE.number(arg(0)) ?? 0
            return Handled(value: formatDate(Date(timeIntervalSince1970: ms / 1000),
                                             locale: JSE.string(d["locale"]), options: (d["options"] as? [String: Any]) ?? [:]))
        }
        if d["__relfmt"] != nil, m == "format" {
            return Handled(value: formatRelative(JSE.number(arg(0)) ?? 0, unit: str(1),
                                                 locale: JSE.string(d["locale"]), options: (d["options"] as? [String: Any]) ?? [:]))
        }
        // URL
        if d["__url"] != nil, m == "toString" || m == "toJSON" {
            return Handled(value: d["href"] ?? "")
        }
        return nil
    }

    /// `'' + date` / `{{ url }}` string coercion for the core shapes.
    static func stringCoerce(_ d: [String: Any]) -> String? {
        if let ms = d["__date"] as? Double {
            let f = ISO8601DateFormatter()
            f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            f.timeZone = TimeZone(identifier: "UTC")
            return f.string(from: Date(timeIntervalSince1970: ms / 1000))
        }
        if d["__url"] != nil { return d["href"] as? String }
        if let entries = d["__params"] as? [Any] { return encodeParams(entries) }
        if d["__error"] != nil { return JSE.string(d["name"] ?? "Error") + ": " + JSE.string(d["message"]) }
        if d["__regex"] != nil { return "/" + JSE.string(d["source"]) + "/" + JSE.string(d["flags"]) }
        return nil
    }

    // ── statement-form mutation (the runner's read-modify-write hook) ─────────────────────
    /// UTC calendar components for the getUTC* getters.
    static func utcComponents(_ date: Date) -> DateComponents {
        var ucal = Calendar(identifier: .gregorian)
        ucal.timeZone = TimeZone(identifier: "UTC") ?? .current
        return ucal.dateComponents([.year, .month, .day, .weekday, .hour, .minute, .second, .nanosecond], from: date)
    }

    /// Author-facing Double → Int for calendar components/deltas: NaN keeps the current
    /// component (`fallback`), huge/±inf saturates to a sane calendar range — a raw
    /// `Int(Double)` TRAPS on NaN/1e30, and every value here is author-controllable (F20).
    private static func calInt(_ d: Double, fallback: Int = 0) -> Int {
        guard !d.isNaN else { return fallback }
        return Int(Swift.min(Swift.max(d, -9.0e15), 9.0e15))
    }

    /// new Date(year, month0[, day[, h[, m[, s[, ms]]]]]) — LOCAL time, component-rolled
    /// like dateSetMS. Any non-finite component → an invalid date (NaN ms), never a trap.
    static func dateFromComponents(_ a: [Any?]) -> Double {
        var vals: [Double] = [1970, 0, 1, 0, 0, 0, 0]
        for i in 0..<7 where i < a.count {
            guard let n = JSE.number(a[i]), n.isFinite else { return Double.nan }
            vals[i] = n
        }
        let cal = Calendar.current
        var comps = DateComponents()
        comps.year = calInt(vals[0]); comps.month = 1; comps.day = 1
        guard var d0 = cal.date(from: comps) else { return Double.nan }
        d0 = cal.date(byAdding: .month, value: calInt(vals[1]), to: d0) ?? d0
        d0 = cal.date(byAdding: .day, value: calInt(vals[2]) - 1, to: d0) ?? d0
        let secs = vals[3] * 3600 + vals[4] * 60 + vals[5] + vals[6] / 1000
        d0 = d0.addingTimeInterval(Swift.min(Swift.max(secs, -8.64e12), 8.64e12))
        return (d0.timeIntervalSince1970 * 1000).rounded()
    }

    /// Local-time Date setter arithmetic — replace the named components (delta-based, so
    /// out-of-range values roll like JS on the common paths), return new ms. TOTAL: every
    /// component conversion rides the calInt clamp (NaN keeps the component, huge deltas
    /// make Calendar return nil and the date rides through) — never a trap (F20).
    static func dateSetMS(_ ms: Double, _ m: String, _ a: [Any?]) -> Double {
        func nn(_ i: Int) -> Double? { i < a.count ? JSE.number(a[i]) : nil }
        if m == "setTime" { return nn(0) ?? 0 }
        var date = Date(timeIntervalSince1970: (ms.isFinite ? ms : 0) / 1000)
        let cal = Calendar.current
        func comp(_ c: Calendar.Component) -> Int { cal.component(c, from: date) }
        func add(_ c: Calendar.Component, _ delta: Int) {
            if delta != 0, let d = cal.date(byAdding: c, value: delta, to: date) { date = d }
        }
        func setMillis(_ target: Double) {
            guard target.isFinite else { return }
            var cur = ms.truncatingRemainder(dividingBy: 1000)
            if cur < 0 { cur += 1000 }
            date = date.addingTimeInterval((target - cur) / 1000)
        }
        switch m {
        case "setFullYear":
            add(.year, calInt(nn(0) ?? Double(comp(.year)), fallback: comp(.year)) - comp(.year))
            if let mo = nn(1) { add(.month, calInt(mo, fallback: comp(.month) - 1) + 1 - comp(.month)) }
            if let d = nn(2) { add(.day, calInt(d, fallback: comp(.day)) - comp(.day)) }
        case "setMonth":
            add(.month, calInt(nn(0) ?? Double(comp(.month) - 1), fallback: comp(.month) - 1) + 1 - comp(.month))
            if let d = nn(1) { add(.day, calInt(d, fallback: comp(.day)) - comp(.day)) }
        case "setDate": add(.day, calInt(nn(0) ?? Double(comp(.day)), fallback: comp(.day)) - comp(.day))
        case "setHours":
            add(.hour, calInt(nn(0) ?? Double(comp(.hour)), fallback: comp(.hour)) - comp(.hour))
            if let mi = nn(1) { add(.minute, calInt(mi, fallback: comp(.minute)) - comp(.minute)) }
            if let s = nn(2) { add(.second, calInt(s, fallback: comp(.second)) - comp(.second)) }
            if let msArg = nn(3) { setMillis(msArg) }
        case "setMinutes":
            add(.minute, calInt(nn(0) ?? Double(comp(.minute)), fallback: comp(.minute)) - comp(.minute))
            if let s = nn(1) { add(.second, calInt(s, fallback: comp(.second)) - comp(.second)) }
            if let msArg = nn(2) { setMillis(msArg) }
        case "setSeconds":
            add(.second, calInt(nn(0) ?? Double(comp(.second)), fallback: comp(.second)) - comp(.second))
            if let msArg = nn(1) { setMillis(msArg) }
        case "setMilliseconds":
            if let msArg = nn(0) { setMillis(msArg) }
        default: break
        }
        return (date.timeIntervalSince1970 * 1000).rounded()
    }

    static let mutatingMethods: Set<String> = ["set", "append", "delete", "abort", "add",
        "setTime", "setFullYear", "setMonth", "setDate", "setHours", "setMinutes", "setSeconds", "setMilliseconds"]
    static func canMutate(_ m: String, _ v: Any?) -> Bool {
        if m.hasPrefix("set"), m != "set", (v as? [String: Any])?["__date"] != nil { return true }   // the Date setters
        guard let d = v as? [String: Any] else { return false }
        if m == "abort" { return d["__controller"] != nil }
        if m == "add" { return d["__set"] != nil }
        return d["__params"] != nil || d["__formdata"] != nil || d["__headers"] != nil
            || d["__map"] != nil || d["__set"] != nil
    }
    static func mutate(_ m: String, _ v: inout Any, args: [Any?]) {
        if m.hasPrefix("set"), m != "set", var dd = v as? [String: Any], let ms = dd["__date"] as? Double {
            dd["__date"] = dateSetMS(ms, m, args)
            v = dd
            return
        }
        guard var d = v as? [String: Any] else { return }
        let key = JSE.string(args.first ?? nil)
        if m == "abort", let id = d["__controller"] as? String {
            JSEAbortFlags.shared.abort(id)
            if var sig = d["signal"] as? [String: Any] { sig["aborted"] = true; d["signal"] = sig }
            v = d; return
        }
        if d["__headers"] != nil {
            switch m {
            case "set", "append": d[key.lowercased()] = JSE.string(args.count > 1 ? args[1] : nil)
            case "delete":        d.removeValue(forKey: key.lowercased())
            default: break
            }
            v = d; return
        }
        // Map: keys are VALUES (JSE.equals), not strings — set replaces, delete removes; size maintained.
        if var entries = d["__map"] as? [Any] {
            let k: Any? = args.first ?? nil
            switch m {
            case "set":
                entries.removeAll { JSE.equals((($0 as? [Any])?.first ?? nil), k) }
                entries.append([k ?? NSNull(), args.count > 1 ? (args[1] ?? NSNull()) : NSNull()])
            case "delete":
                entries.removeAll { JSE.equals((($0 as? [Any])?.first ?? nil), k) }
            default: break
            }
            d["__map"] = entries; d["size"] = Double(entries.count)
            v = d; return
        }
        if var values = d["__set"] as? [Any] {
            let k: Any? = args.first ?? nil
            switch m {
            case "add":    if !values.contains(where: { JSE.equals($0, k) }) { values.append(k ?? NSNull()) }
            case "delete": values.removeAll { JSE.equals($0, k) }
            default: break
            }
            d["__set"] = values; d["size"] = Double(values.count)
            v = d; return
        }
        let listKey = d["__params"] != nil ? "__params" : "__formdata"
        var entries = (d[listKey] as? [Any]) ?? []
        switch m {
        case "append":
            entries.append([key, args.count > 1 ? (args[1] ?? "") : ""])
        case "set":
            let value: Any = args.count > 1 ? (args[1] ?? "") : ""
            entries.removeAll { (($0 as? [Any])?.first).map { JSE.string($0) == key } ?? false }
            entries.append([key, value])
        case "delete":
            entries.removeAll { (($0 as? [Any])?.first).map { JSE.string($0) == key } ?? false }
        default: break
        }
        d[listKey] = entries
        v = d
    }
    static func aborted(_ id: String) -> Bool { JSEAbortFlags.shared.isAborted(id) }

    // ── URL plumbing ───────────────────────────────────────────────────────────────────────
    private static func makeURL(_ input: String, base: String?) -> [String: Any]? {
        let resolved: URL?
        if let base, let b = URL(string: base) { resolved = URL(string: input, relativeTo: b)?.absoluteURL }
        else { resolved = URL(string: input) }
        guard let u = resolved, let comps = URLComponents(url: u, resolvingAgainstBaseURL: true) else { return nil }
        let scheme = comps.scheme ?? ""
        let hostname = comps.host ?? ""
        let port = comps.port.map(String.init) ?? ""
        let host = hostname + (port.isEmpty ? "" : ":" + port)
        var entries: [Any] = []
        for item in comps.queryItems ?? [] { entries.append([item.name, item.value ?? ""]) }
        return ["__url": true,
                "href": u.absoluteString,
                "protocol": scheme + ":",
                "hostname": hostname, "port": port, "host": host,
                "origin": scheme.isEmpty || hostname.isEmpty ? "" : scheme + "://" + host,
                "pathname": comps.percentEncodedPath.isEmpty ? "/" : comps.percentEncodedPath,
                "search": (comps.percentEncodedQuery?.isEmpty == false) ? "?" + comps.percentEncodedQuery! : "",
                "hash": (comps.fragment?.isEmpty == false) ? "#" + comps.fragment! : "",
                "searchParams": ["__params": entries]]
    }
    /// After a searchParams mutation: rebuild `search` + `href` from the entries.
    static func resyncURL(_ d: inout [String: Any]) {
        let entries = ((d["searchParams"] as? [String: Any])?["__params"] as? [Any]) ?? []
        let query = encodeParams(entries)
        guard var comps = URLComponents(string: (d["href"] as? String) ?? "") else { return }
        comps.percentEncodedQuery = query.isEmpty ? nil : query
        d["search"] = query.isEmpty ? "" : "?" + query
        d["href"] = comps.string ?? (d["href"] as? String ?? "")
    }
    private static func parseParams(_ v: Any?) -> [Any] {
        var entries: [Any] = []
        if let s = v as? String {
            let body = s.hasPrefix("?") ? String(s.dropFirst()) : s
            for pair in body.split(separator: "&") {
                let kv = pair.split(separator: "=", maxSplits: 1).map(String.init)
                entries.append([formDecode(kv.first ?? ""), formDecode(kv.count > 1 ? kv[1] : "")])
            }
        } else if let d = v as? [String: Any] {
            for (k, val) in d where !k.hasPrefix("__") { entries.append([k, JSE.string(val)]) }
        } else if let arr = v as? [Any] {
            for e in arr { if let pair = e as? [Any], pair.count >= 2 { entries.append([JSE.string(pair[0]), JSE.string(pair[1])]) } }
        }
        return entries
    }
    /// application/x-www-form-urlencoded (the URLSearchParams contract: space → '+').
    private static func encodeParams(_ entries: [Any]) -> String {
        entries.compactMap { e -> String? in
            guard let pair = e as? [Any], let k = pair.first else { return nil }
            return formEncode(JSE.string(k)) + "=" + formEncode(JSE.string(pair.count > 1 ? pair[1] : ""))
        }.joined(separator: "&")
    }
    private static func formEncode(_ s: String) -> String {
        var out = ""
        for b in Array(s.utf8) {
            let c = Character(UnicodeScalar(b))
            if (c.isLetter && c.isASCII) || c.isNumber || "-._*".contains(c) { out.append(c) }
            else if c == " " { out.append("+") }
            else { out += String(format: "%%%02X", b) }
        }
        return out
    }
    private static func formDecode(_ s: String) -> String {
        s.replacingOccurrences(of: "+", with: " ").removingPercentEncoding ?? s
    }
    private static func percentEncode(_ s: String, keep: String) -> String {
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: keep)
        return s.addingPercentEncoding(withAllowedCharacters: allowed) ?? s
    }

    // ── fetch body plumbing (shared with the runner's fetchOp) ────────────────────────────
    static func applyHeaders(_ v: Any?, into headers: inout [String: String]) {
        guard let h = v as? [String: Any] else { return }
        for (k, val) in h where !k.hasPrefix("__") { headers[k] = JSE.string(val) }
    }
    private static func hasContentType(_ headers: [String: String]) -> Bool {
        headers.keys.contains { $0.lowercased() == "content-type" }
    }
    static func bodyData(_ v: Any?, headers: inout [String: String]) -> Data? {
        guard let v else { return nil }
        if let s = v as? String {                                          // JSON.stringify output / raw text
            if !hasContentType(headers) { headers["Content-Type"] = "text/plain;charset=UTF-8" }
            return Data(s.utf8)
        }
        if let d = v as? [String: Any] {
            if let entries = d["__formdata"] as? [Any] { return multipart(entries, headers: &headers) }
            if let b64 = d["__blob"] as? String {
                if !hasContentType(headers), let t = d["type"] as? String, !t.isEmpty { headers["Content-Type"] = t }
                return Data(base64Encoded: b64)
            }
            if d["__params"] != nil, let entries = d["__params"] as? [Any] {   // URLSearchParams body → form-encoded
                if !hasContentType(headers) { headers["Content-Type"] = "application/x-www-form-urlencoded;charset=UTF-8" }
                return Data(encodeParams(entries).utf8)
            }
            let clean = jsonSanitize(d)
            if JSONSerialization.isValidJSONObject(clean) { return try? JSONSerialization.data(withJSONObject: clean) }
            return nil
        }
        if let arr = v as? [Any], JSONSerialization.isValidJSONObject(arr) {
            return try? JSONSerialization.data(withJSONObject: jsonSanitize(arr))
        }
        return nil
    }
    private static func blobData(_ v: Any?) -> Data? {
        guard let d = v as? [String: Any], let b64 = d["__blob"] as? String else { return nil }
        return Data(base64Encoded: b64)
    }
    private static func multipart(_ entries: [Any], headers: inout [String: String]) -> Data {
        let boundary = "dsx-" + UUID().uuidString
        headers = headers.filter { $0.key.lowercased() != "content-type" }
        headers["Content-Type"] = "multipart/form-data; boundary=\(boundary)"
        var d = Data()
        func ap(_ s: String) { d.append(Data(s.utf8)) }
        for e in entries {
            guard let pair = e as? [Any], pair.count >= 2 else { continue }
            let name = JSE.string(pair[0])
            ap("--\(boundary)\r\n")
            if let f = pair[1] as? [String: Any], let b64 = f["__blob"] as? String {
                let filename = (f["name"] as? String) ?? "blob"
                let typeStr = (f["type"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "application/octet-stream"
                ap("Content-Disposition: form-data; name=\"\(name)\"; filename=\"\(filename)\"\r\n")
                ap("Content-Type: \(typeStr)\r\n\r\n")
                d.append(Data(base64Encoded: b64) ?? Data())
                ap("\r\n")
            } else {
                ap("Content-Disposition: form-data; name=\"\(name)\"\r\n\r\n")
                ap(JSE.string(pair[1]))
                ap("\r\n")
            }
        }
        ap("--\(boundary)--\r\n")
        return d
    }

    /// JS parseInt: trims, optional sign, optional 0x (radix 16), parses the LEADING digits
    /// in `radix` (default 10) and ignores the rest; nothing parseable → NaN.
    private static func parseIntJS(_ s: String, radix: Int?) -> Double {
        var str = s.trimmingCharacters(in: .whitespaces)
        var sign = 1.0
        if str.hasPrefix("-") { sign = -1; str.removeFirst() } else if str.hasPrefix("+") { str.removeFirst() }
        var r = radix ?? 10
        if (r == 16 || radix == nil), str.lowercased().hasPrefix("0x") { str = String(str.dropFirst(2)); r = 16 }
        guard (2...36).contains(r) else { return Double.nan }
        var head = ""
        for ch in str.lowercased() {
            let v: Int
            if ch.isNumber, let d = ch.wholeNumberValue { v = d }
            else if ch.isLetter, let a = ch.asciiValue { v = Int(a) - 97 + 10 }
            else { break }
            if v >= r { break }
            head.append(ch)
        }
        guard !head.isEmpty, let n = Int(head, radix: r) else { return Double.nan }
        return sign * Double(n)
    }

    // ── Date parsing ──────────────────────────────────────────────────────────────────────
    private static func parseDateMS(_ v: Any?) -> Double {
        if let d = v as? [String: Any], let ms = d["__date"] as? Double { return ms }   // new Date(date) = copy
        if let n = v as? Double { return n }
        if let n = v as? Int { return Double(n) }
        guard let s = v as? String, !s.isEmpty else { return JSE.number(v) ?? Double.nan }
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = iso.date(from: s) { return d.timeIntervalSince1970 * 1000 }
        iso.formatOptions = [.withInternetDateTime]
        if let d = iso.date(from: s) { return d.timeIntervalSince1970 * 1000 }
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        for (fmt, utc) in [("yyyy-MM-dd", true), ("yyyy-MM-dd HH:mm:ss", false), ("yyyy/MM/dd", false)] {
            f.dateFormat = fmt
            f.timeZone = utc ? TimeZone(identifier: "UTC") : TimeZone.current   // date-only ISO is UTC, like JS
            if let d = f.date(from: s) { return d.timeIntervalSince1970 * 1000 }
        }
        return Double.nan
    }

    // ── Intl formatting (NumberFormatter / DateFormatter / RelativeDateTimeFormatter) ──────
    private static func formatNumber(_ n: Double, locale: String, options: [String: Any]) -> String {
        let f = NumberFormatter()
        f.locale = locale.isEmpty ? Locale.current : Locale(identifier: locale)
        switch JSE.string(options["style"]) {
        case "currency":
            f.numberStyle = .currency
            let code = JSE.string(options["currency"])
            if !code.isEmpty { f.currencyCode = code }
        case "percent": f.numberStyle = .percent
        default:        f.numberStyle = .decimal
        }
        if let v = options["minimumFractionDigits"].flatMap({ JSE.number($0) }) { f.minimumFractionDigits = Int(v) }
        if let v = options["maximumFractionDigits"].flatMap({ JSE.number($0) }) { f.maximumFractionDigits = Int(v) }
        if let g = options["useGrouping"] { f.usesGroupingSeparator = JSE.truthy(g) }
        return f.string(from: NSNumber(value: n)) ?? "\(n)"
    }
    private static func formatDate(_ date: Date, locale: String, options: [String: Any]) -> String {
        let f = DateFormatter()
        f.locale = locale.isEmpty ? Locale.current : Locale(identifier: locale)
        func style(_ s: String) -> DateFormatter.Style {
            switch s { case "full": return .full; case "long": return .long; case "medium": return .medium; case "short": return .short; default: return .none }
        }
        let ds = JSE.string(options["dateStyle"]), ts = JSE.string(options["timeStyle"])
        if !ds.isEmpty || !ts.isEmpty {
            f.dateStyle = style(ds); f.timeStyle = style(ts)
            return f.string(from: date)
        }
        // Component options → a localized skeleton (year:'numeric' month:'long' day:'numeric' …)
        var skeleton = ""
        func add(_ key: String, _ map: [String: String]) {
            let v = JSE.string(options[key]); if let s = map[v] { skeleton += s }
        }
        add("weekday", ["narrow": "EEEEE", "short": "EEE", "long": "EEEE"])
        add("year",    ["numeric": "y", "2-digit": "yy"])
        add("month",   ["numeric": "M", "2-digit": "MM", "narrow": "MMMMM", "short": "MMM", "long": "MMMM"])
        add("day",     ["numeric": "d", "2-digit": "dd"])
        add("hour",    ["numeric": "j", "2-digit": "jj"])
        add("minute",  ["numeric": "m", "2-digit": "mm"])
        add("second",  ["numeric": "s", "2-digit": "ss"])
        if skeleton.isEmpty { f.dateStyle = .short; return f.string(from: date) }   // JS default: numeric date
        f.setLocalizedDateFormatFromTemplate(skeleton)
        return f.string(from: date)
    }
    private static func formatRelative(_ value: Double, unit: String, locale: String, options: [String: Any]) -> String {
        let f = RelativeDateTimeFormatter()
        f.locale = locale.isEmpty ? Locale.current : Locale(identifier: locale)
        if JSE.string(options["numeric"]) == "auto" { f.dateTimeStyle = .named }   // "yesterday", not "1 day ago"
        var comps = DateComponents()
        let v = Int(value)
        switch unit.hasSuffix("s") ? String(unit.dropLast()) : unit {
        case "second":  comps.second = v
        case "minute":  comps.minute = v
        case "hour":    comps.hour = v
        case "day":     comps.day = v
        case "week":    comps.weekOfMonth = v
        case "month":   comps.month = v
        case "quarter": comps.month = v * 3
        case "year":    comps.year = v
        default:        comps.day = v
        }
        return f.localizedString(from: comps)
    }

    // ── JSON sanitize + deep copy ─────────────────────────────────────────────────────────
    /// JSON.stringify / fetch-body view of core shapes: Date → ISO (its toJSON), URL → href,
    /// URLSearchParams → query string, Blob → null; "__" marker keys never serialize.
    static func jsonSanitize(_ v: Any) -> Any {
        if let d = v as? [String: Any] {
            if let ms = d["__date"] as? Double {
                let f = ISO8601DateFormatter()
                f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
                f.timeZone = TimeZone(identifier: "UTC")
                return f.string(from: Date(timeIntervalSince1970: ms / 1000))
            }
            if d["__url"] != nil { return d["href"] ?? "" }
            if let entries = d["__params"] as? [Any] { return encodeParams(entries) }
            if d["__blob"] != nil || d["__formdata"] != nil { return NSNull() }
            var out: [String: Any] = [:]
            for (k, val) in d where !k.hasPrefix("__") { out[k] = jsonSanitize(val) }
            return out
        }
        if let arr = v as? [Any] { return arr.map { jsonSanitize($0) } }
        return v
    }
    static func deepCopy(_ v: Any?) -> Any {
        guard let v else { return NSNull() }
        if let d = v as? [String: Any] {
            var out: [String: Any] = [:]
            for (k, val) in d { out[k] = deepCopy(val) }
            return out
        }
        if let arr = v as? [Any] { return arr.map { deepCopy($0) } }
        return v
    }
}

/// Process-global abort flags (`AbortController` ids). The signal dict carries the id; an
/// in-flight fetch checks the flag when it settles — abort = the result is discarded and
/// `{ ok:false, error:'aborted' }` lands instead.
final class JSEAbortFlags {
    static let shared = JSEAbortFlags()
    private let lock = NSLock()
    private var ids = Set<String>()
    func abort(_ id: String) { lock.lock(); ids.insert(id); lock.unlock() }
    func isAborted(_ id: String) -> Bool { lock.lock(); defer { lock.unlock() }; return ids.contains(id) }
}

/// `console.*` sink: NSLog (visible in Console.app / Xcode) + a bounded ring buffer the
/// debugger/inspector reads. Process-global, lock-guarded, capped — logging can never grow
/// memory unbounded or crash a surface.
final class JSEConsole {
    static let shared = JSEConsole()
    private let lock = NSLock()
    private(set) var lines: [String] = []
    private let cap = 500
    func append(level: String, _ message: String) {
        NSLog("[DSX console] %@: %@", level, message)
        lock.lock()
        lines.append("\(level): \(message)")
        if lines.count > cap { lines.removeFirst(lines.count - cap) }
        lock.unlock()
    }
}

/// `navigator.onLine` — a lazy NWPathMonitor singleton (starts on first read; defaults to
/// true until the first path update lands, so the read never blocks).
final class JSEReachability {
    static let shared = JSEReachability()
    private let monitor = NWPathMonitor()
    private var started = false
    private let lock = NSLock()
    private var satisfied = true
    var onLine: Bool {
        lock.lock(); defer { lock.unlock() }
        if !started {
            started = true
            monitor.pathUpdateHandler = { [weak self] path in
                guard let self else { return }
                self.lock.lock(); self.satisfied = (path.status == .satisfied); self.lock.unlock()
            }
            monitor.start(queue: DispatchQueue(label: "dsx.reachability"))
        }
        return satisfied
    }
}

// MARK: - JSE · RegExp (1:1) — /pattern/flags + new RegExp → NSRegularExpression (ICU)
//
// The standard JS regex surface for VALIDATION / PARSING / CLEANUP — computation, not a
// capability. Literals (`/^[a-z]+$/i.test(x)`) tokenize with the standard JS lexer
// heuristic (a `/` in prefix position starts a literal; after a value it's division), and
// `new RegExp(pattern, flags)` builds the same value dict ({ __regex, source, flags }).
//
//   re.test(s)                       → Bool
//   s.match(re)                      → g: every full match · else [full, group1, …] | null
//   s.replace(re | str, tmpl)        → first occurrence ($1 templates, ICU-native); g: all
//   s.replaceAll(re | str, tmpl)     → all occurrences
//   s.split(re | str [, limit])      → parts
//   s.search(re)                     → first match index (UTF-16, like JS) | -1
//
// Flags: i (case-insensitive) · m (multiline anchors) · s (dot matches newlines) ·
// g (behavioral: match-all / replace-all) · u (ICU is Unicode already). Compiled patterns
// are cached (pattern+flags, capped). Total: a bad pattern logs `[JSE regex]` → null.
// Known edges (documented): inside a literal, spell `/` as `\/` (required by JS anyway);
// `$$`-style template escaping follows ICU, not JS.

enum JSERegex {
    private static let lock = NSLock()
    private static var cache: [String: NSRegularExpression] = [:]

    /// If `chars[i]` begins an UNBOUNDED quantifier (`*`, `+`, or `{n,}`), return the index just
    /// past it (incl. a trailing lazy `?`); else -1. `{n}`/`{n,m}` are BOUNDED, not counted.
    /// Twin of regex.ts `unboundedQuantAt`.
    private static func unboundedQuantAt(_ chars: [Character], _ i: Int) -> Int {
        guard i < chars.count else { return -1 }
        let ch = chars[i]
        if ch == "*" || ch == "+" { return (i + 1 < chars.count && chars[i + 1] == "?") ? i + 2 : i + 1 }
        if ch == "{" {
            var close = -1
            var k = i + 1
            while k < chars.count { if chars[k] == "}" { close = k; break }; k += 1 }
            if close < 0 { return -1 }
            let inner = String(chars[(i + 1)..<close])
            if inner.count >= 2, inner.last == ",", inner.dropLast().allSatisfy({ $0.isNumber }) {
                return (close + 1 < chars.count && chars[close + 1] == "?") ? close + 2 : close + 1
            }
        }
        return -1
    }

    /// Reject catastrophic-backtracking patterns — star height ≥ 2 (a group whose body holds an
    /// unbounded quantifier and which is itself unbounded-quantified: `(a+)+`, `(a*)*`, `(.*)*`).
    /// Conservative by design; graceful no-match, never a hang. Twin of regex.ts `reDoSProne`.
    static func reDoSProne(_ source: String) -> Bool {
        let chars = Array(source)
        var bodyUnbounded: [Bool] = []
        var inClass = false
        var i = 0
        let n = chars.count
        while i < n {
            let ch = chars[i]
            if ch == "\\" { i += 2; continue }
            if inClass { if ch == "]" { inClass = false }; i += 1; continue }
            if ch == "[" { inClass = true; i += 1; continue }
            if ch == "(" { bodyUnbounded.append(false); i += 1; continue }
            if ch == ")" {
                let inner = bodyUnbounded.isEmpty ? false : bodyUnbounded.removeLast()
                let q = unboundedQuantAt(chars, i + 1)
                if q >= 0 {
                    if inner { return true }
                    if !bodyUnbounded.isEmpty { bodyUnbounded[bodyUnbounded.count - 1] = true }
                    i = q; continue
                }
                i += 1; continue
            }
            let q = unboundedQuantAt(chars, i)
            if q >= 0 {
                if !bodyUnbounded.isEmpty { bodyUnbounded[bodyUnbounded.count - 1] = true }
                i = q; continue
            }
            i += 1
        }
        return false
    }

    /// The arg can be a regex dict or a plain string (string-arg replace/split are LITERAL,
    /// per JS — handled by the callers; this resolves only real regex values).
    private static func compiled(_ v: Any?) -> (re: NSRegularExpression, global: Bool)? {
        guard let d = v as? [String: Any], d["__regex"] != nil else { return nil }
        let pattern = JSE.string(d["source"]), flags = JSE.string(d["flags"])
        let key = flags + "\u{1}" + pattern
        lock.lock()
        if let hit = cache[key] { lock.unlock(); return (hit, flags.contains("g")) }
        lock.unlock()
        if reDoSProne(pattern) {
            NSLog("[JSE regex] rejected a potentially-catastrophic pattern (nested unbounded quantifier): /%@/%@", pattern, flags)
            return nil
        }
        var opts: NSRegularExpression.Options = []
        if flags.contains("i") { opts.insert(.caseInsensitive) }
        if flags.contains("m") { opts.insert(.anchorsMatchLines) }
        if flags.contains("s") { opts.insert(.dotMatchesLineSeparators) }
        guard let re = try? NSRegularExpression(pattern: pattern, options: opts) else {
            NSLog("[JSE regex] invalid pattern: /%@/%@", pattern, flags)
            return nil
        }
        lock.lock()
        if cache.count > 128 { cache.removeAll() }
        cache[key] = re
        lock.unlock()
        return (re, flags.contains("g"))
    }

    static func test(_ s: String, _ regex: Any?) -> Bool {
        guard let (re, _) = compiled(regex) else { return false }
        return re.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) != nil
    }

    static func match(_ s: String, _ regex: Any?) -> Any? {
        guard let (re, global) = compiled(regex) else { return nil }
        let ns = s as NSString
        let full = NSRange(location: 0, length: ns.length)
        if global {
            let all = re.matches(in: s, range: full).map { ns.substring(with: $0.range) }
            return all.isEmpty ? nil : all
        }
        guard let m = re.firstMatch(in: s, range: full) else { return nil }
        var out: [Any] = []
        for i in 0..<m.numberOfRanges {
            let r = m.range(at: i)
            out.append(r.location == NSNotFound ? NSNull() : ns.substring(with: r))
        }
        return out
    }

    /// Every match as a match ARRAY ([full, g1, …] — unmatched group → NSNull), always
    /// global semantics (the JS matchAll contract; the `g` flag is implied).
    static func matchAll(_ s: String, _ regex: Any?) -> [Any] {
        guard let (re, _) = compiled(regex) else { return [] }
        let ns = s as NSString
        let full = NSRange(location: 0, length: ns.length)
        return re.matches(in: s, range: full).map { m in
            var out: [Any] = []
            for i in 0..<m.numberOfRanges {
                let r = m.range(at: i)
                out.append(r.location == NSNotFound ? NSNull() : ns.substring(with: r))
            }
            return out
        }
    }

    static func search(_ s: String, _ regex: Any?) -> Double {
        guard let (re, _) = compiled(regex) else { return -1 }
        guard let m = re.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) else { return -1 }
        return Double(m.range.location)                      // UTF-16 index, like JS
    }

    static func replace(_ s: String, _ pattern: Any?, template: String, all: Bool) -> String {
        if let (re, global) = compiled(pattern) {
            let ns = NSMutableString(string: s)
            let full = NSRange(location: 0, length: ns.length)
            if all || global {
                _ = re.replaceMatches(in: ns, range: full, withTemplate: template)
                return ns as String
            }
            guard let m = re.firstMatch(in: s, range: full) else { return s }
            let rep = re.replacementString(for: m, in: s, offset: 0, template: template)
            ns.replaceCharacters(in: m.range, with: rep)
            return ns as String
        }
        // String pattern — LITERAL (JS semantics: replace = first occurrence, replaceAll = every)
        let find = JSE.string(pattern)
        guard !find.isEmpty else { return s }
        if all { return s.replacingOccurrences(of: find, with: template) }
        guard let r = s.range(of: find) else { return s }
        return s.replacingCharacters(in: r, with: template)
    }

    static func split(_ s: String, _ pattern: Any?, limit: Int) -> [Any] {
        var parts: [String]
        if let (re, _) = compiled(pattern) {
            let ns = s as NSString
            var out: [String] = []
            var start = 0
            for m in re.matches(in: s, range: NSRange(location: 0, length: ns.length)) {
                out.append(ns.substring(with: NSRange(location: start, length: m.range.location - start)))
                start = m.range.location + m.range.length
            }
            out.append(ns.substring(from: start))
            parts = out
        } else {
            let sep = JSE.string(pattern)
            parts = sep.isEmpty ? s.map(String.init) : s.components(separatedBy: sep)
        }
        if limit > 0, parts.count > limit { parts = Array(parts.prefix(limit)) }
        return parts
    }
}



/// Log redaction — any value whose KEY looks like a credential masks to "•••" before it
/// reaches console/trace output (NSLog lands in sysdiagnoses and crash uploads; secrets
/// must never ride along). Applied recursively to dicts/arrays at serialization time —
/// the live values in the store are untouched. Production logging policy: see
/// OpenSource/Skills/security.md.
enum JSERedact {
    private static let sensitive = ["token", "secret", "password", "passwd", "authorization",
                                    "cookie", "apikey", "api_key", "api-key", "bearer",
                                    "credential", "session_id", "sessionid", "private_key", "privatekey"]
    static func isSensitive(_ key: String) -> Bool {
        let k = key.lowercased()
        return sensitive.contains { k == $0 || k.hasSuffix("_" + $0) || k.hasSuffix($0) && $0.count > 5 }
    }
    static func mask(_ v: Any) -> Any {
        if let d = v as? [String: Any] {
            var out: [String: Any] = [:]
            for (k, val) in d { out[k] = isSensitive(k) ? "•••" : mask(val) }
            return out
        }
        if let arr = v as? [Any] { return arr.map { mask($0) } }
        return v
    }
}

/// JSETrace — the diagnostics layer behind the inspector: capped ring buffers per category
/// (`action` name+duration · `state` key old→new · `fetch` method/url/status/ms · `package`
/// callee/outcome/ms · `socket` key/event). OFF by default in release (one bool check per
/// site — zero work when disabled), ON in DEBUG builds. Values pass JSERedact before they
/// land. Read it natively via `JSETrace.shared.dump()` (the StateLab web accessor is
/// retired with that harness — Custom/Demo replaced it).
final class JSETrace {
    static let shared = JSETrace()
    var enabled: Bool
    private let lock = NSLock()
    private var buffers: [String: [String]] = [:]
    private let cap = 300
    private let epoch = Date()

    private init() {
        #if DEBUG
        enabled = true
        #else
        enabled = false
        #endif
    }

    func log(_ category: String, _ line: String) {
        guard enabled else { return }
        let t = Int(Date().timeIntervalSince(epoch) * 1000)
        lock.lock()
        var b = buffers[category] ?? []
        b.append("+\(t)ms \(line)")
        if b.count > cap { b.removeFirst(b.count - cap) }
        buffers[category] = b
        lock.unlock()
    }

    /// State-write entry — redacts by KEY (a sensitive key masks the whole value) and
    /// truncates so a big list write doesn't flood the buffer.
    func state(_ key: String, old: Any?, new: Any?) {
        let o = JSERedact.isSensitive(key) ? "•••" : short(old)
        let n = JSERedact.isSensitive(key) ? "•••" : short(new)
        log("state", "\(key): \(o) → \(n)")
    }
    private func short(_ v: Any?) -> String {
        guard let v else { return "null" }
        var s: String
        if let d = v as? [String: Any], let data = try? JSONSerialization.data(withJSONObject: JSERedact.mask(JSECore.jsonSanitize(d))) {
            s = String(decoding: data, as: UTF8.self)
        } else if let a = v as? [Any] {
            s = "[\(a.count) items]"
        } else {
            s = JSE.string(v)
        }
        return s.count > 120 ? String(s.prefix(120)) + "…" : s
    }

    func dump() -> [String: [String]] { lock.lock(); defer { lock.unlock() }; return buffers }
    func clear() { lock.lock(); buffers = [:]; lock.unlock() }
}

extension JSERedact {
    /// Mask credential-looking QUERY values in a URL for logging (`?token=…` → `?token=•••`).
    static func maskURL(_ url: String) -> String {
        guard url.contains("?") else { return url }
        return url.replacingOccurrences(
            of: #"([?&](?:token|secret|password|authorization|cookie|api[_-]?key|bearer|credential|session_id|key)=)[^&#]*"#,
            with: "$1•••", options: [.regularExpression, .caseInsensitive])
    }
}
