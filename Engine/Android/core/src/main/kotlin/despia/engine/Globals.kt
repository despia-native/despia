@file:Suppress("UNCHECKED_CAST")

//
//  Globals.kt - the JS core globals + Web Crypto for JSE. Kotlin twin of the
//  Stack.swift "JSE · JS core globals" and "JSE · Web Crypto" sections (the JSECore /
//  JSECrypto enums, Stack.swift ~4705-6428) — same names, same arguments, same behaviors.
//  Jse.kt's JSECore/JSECrypto seam objects route here (the exact dispatch points the
//  stubs reserved); this file contains the implementations.
//
//  Pure JVM: java.security / javax.crypto (SHA/HMAC/AES/EC/RSA/EdDSA/XDH),
//  java.util.Base64, java.time + java.text (Date/Intl), hand-rolled URL/percent-coding
//  (Foundation-URLComponents-shaped, NOT java.net.URI — see below). No android.*.
//
//  ── PINNED DECISIONS (Swift = reference; divergences documented, per PLAN.md rule 1) ──
//  • URL: hand-rolled RFC 3986 parse + resolve (Foundation URL/URLComponents implements
//    3986; java.net.URI is RFC 2396-based and diverges on query-only/fragment-only
//    relative refs). Strings containing whitespace/control chars are invalid → null,
//    like URL(string:). Components mirror URLComponents: pathname/search stay
//    percent-ENCODED, hash and searchParams entries percent-DECODE ('+' preserved —
//    queryItems are not form-aware), empty path → "/".
//  • encodeURIComponent/encodeURI: UTF-8 bytes, ASCII-alphanumeric + keep-set stay raw
//    (addingPercentEncoding ignores non-ASCII members of the allowed set, so non-ASCII
//    always encodes — fixture U4). decodeURI(Component): full percent-decode; malformed
//    or invalid UTF-8 → the input unchanged (removingPercentEncoding == nil fallback).
//  • URLSearchParams: application/x-www-form-urlencoded (space → '+'; keep-set "-._*"
//    ASCII-alphanumeric; %XX uppercase). Byte-level Swift curiosity NOT copied: Swift's
//    formEncode leaves Latin-1 digit-like bytes (¹²³) raw via Character.isNumber — a
//    non-contractual accident on non-ASCII bytes; here every non-ASCII byte encodes.
//  • Date: parse accepts ISO date-time WITH zone (fractional or not), then
//    "yyyy-MM-dd" (UTC — the JS quirk), "yyyy-MM-dd HH:mm:ss" (LOCAL), "yyyy/MM/dd"
//    (LOCAL); anything else (incl. 'T' date-times WITHOUT zone — iOS yields NaN too,
//    no formatter matches) → NaN. Getters are LOCAL time (system zone); toISOString
//    is always UTC with exactly 3 fraction digits. NaN dates: getTime is NaN; other
//    getters clamp to epoch (total — Swift would hand Calendar a garbage Date).
//  • Intl: java.text formatters (:core is pure JVM — android.icu rides :platform).
//    NumberFormat: decimal/currency/percent + min/max fraction digits + useGrouping,
//    1:1 with NumberFormatter. DateTimeFormat: dateStyle/timeStyle map to
//    java.text.DateFormat styles; the component-skeleton path has NO
//    DateTimePatternGenerator on the JVM — field order/separators derive from the
//    locale's SHORT pattern (documented approximation; no conformance fixture pins
//    skeleton output). 'j' resolves to the locale's preferred hour cycle from its
//    SHORT time pattern. RelativeTimeFormat: English-only CLDR-shaped fallback
//    (RelativeDateTimeFormatter has no JVM twin; ICU version rides :platform).
//  • JSON: stringify escapes '/' as '\/' (JSONSerialization default), integral finite
//    doubles print as integers (the JSE string() rule), NaN/Infinity/non-JSON values →
//    null (isValidJSONObject fail). Pretty (space > 0) = 2-space indent + " : " (the
//    Foundation shape; byte-exactness of pretty output is not fixture-pinned). parse:
//    numbers → Double, null → NSNull (present-but-null), invalid → log + null.
//  • Crypto: AES-GCM = Cipher AES/GCM/NoPadding — Java already appends the 16-byte tag,
//    matching WebCrypto's ciphertext ‖ tag (do NOT re-append). AES-CBC = PKCS5 (== PKCS7
//    here). AES-CTR = full 16-byte big-endian counter block. ECDSA = SHAxxxwithECDSAin
//    P1363Format (raw r‖s, the WebCrypto layout — never DER). EC private material = raw
//    scalar (curve-size bytes); public = X9.63 uncompressed 04‖X‖Y; imports VALIDATE
//    (on-curve check / scalar range) like CryptoKit init. Ed25519/X25519 raw = RFC 8032/
//    7748 32 bytes (JDK 15+ EdEC/XEC). RSA material = PKCS#1 (SecKey's external
//    representation) with the same minimal-DER SPKI/PKCS#8 wrap/unwrap; PSS saltLength
//    must equal the hash length; OAEP labels unsupported; publicExponent 65537 only.
//    PBKDF2 + HKDF are hand-rolled on Mac (byte-exact, and CommonCrypto-total where
//    JCE would reject an empty password). getRandomValues = SecureRandom (1…65536).
//  • EC/Ed25519/X25519 public-from-private: the JDK cannot derive it (CryptoKit can), so
//    private-key dicts stash the public raw in an internal "__pub" field at generate/
//    import (jwk imports read the spec's `x`/`y` members). A private key imported
//    WITHOUT its public half still signs/derives/exports pkcs8, but its jwk export
//    logs + yields null (documented divergence — iOS derives; no fixture pins it).
//  • console.* → kernelLog + the JSEConsole ring buffer (cap 500); JSERedact's key
//    list is the contract — identical to iOS. performance.now = System.nanoTime()
//    (uptime-monotonic, like ProcessInfo.systemUptime).
//  Statement-form pieces (mutate/canMutate/resyncURL/aborted, applyHeaders/bodyData/
//  multipart) ship here with the section — JseRunner.kt (wave 3) consumes them.
//  Async: Swift's crypto dispatch is fully synchronous (statement-level `await` only
//  hops threads; expression-position `await v` on a non-promise is `v`) — so these
//  calls are synchronous here too, and Jse.kt's prefix `await` no-op already matches.
//

package despia.engine

import java.math.BigInteger
import java.security.AlgorithmParameters
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.MessageDigest
import java.security.SecureRandom
import java.security.Signature
import java.security.interfaces.ECPrivateKey
import java.security.interfaces.ECPublicKey
import java.security.interfaces.EdECPrivateKey
import java.security.interfaces.EdECPublicKey
import java.security.interfaces.XECPrivateKey
import java.security.interfaces.XECPublicKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECParameterSpec
import java.security.spec.ECPoint
import java.security.spec.ECPrivateKeySpec
import java.security.spec.ECPublicKeySpec
import java.security.spec.EdECPoint
import java.security.spec.EdECPrivateKeySpec
import java.security.spec.EdECPublicKeySpec
import java.security.spec.MGF1ParameterSpec
import java.security.spec.NamedParameterSpec
import java.security.spec.PKCS8EncodedKeySpec
import java.security.spec.PSSParameterSpec
import java.security.spec.RSAKeyGenParameterSpec
import java.security.spec.X509EncodedKeySpec
import java.security.spec.XECPrivateKeySpec
import java.security.spec.XECPublicKeySpec
import java.text.DateFormat
import java.text.NumberFormat
import java.text.SimpleDateFormat
import java.time.Instant
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.ZoneId
import java.time.ZoneOffset
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import java.util.Base64
import java.util.Currency
import java.util.Locale
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.KeyAgreement
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.IvParameterSpec
import javax.crypto.spec.OAEPParameterSpec
import javax.crypto.spec.PSource
import javax.crypto.spec.SecretKeySpec

// MARK: - JSECoreGlobals (the Stack.swift JSECore implementation; Jse.kt's JSECore routes here)

internal object JSECoreGlobals {

    // ── entry (everything except Math.*, which Jse.kt's JSECore keeps 1:1) ────────────────
    fun call(name: String, a: List<Any?>): Any? {
        fun arg(i: Int): Any? = a.getOrNull(i)
        fun str(i: Int): String = JSE.string(arg(i))
        when (name) {
            // ── URL / URLSearchParams ──
            "URL" -> {
                val baseHref: String? = (arg(1) as? Map<String, Any?>)?.get("href") as? String ?: arg(1) as? String
                val u = makeURL(str(0), baseHref)
                if (u == null) { kernelLog("[JSE core] URL: invalid '${str(0)}'"); return null }
                return u
            }
            "URLSearchParams" -> return linkedMapOf<String, Any?>("__params" to parseParams(arg(0)))
            // ── fetch companions ──
            "Headers" -> {
                val h = linkedMapOf<String, Any?>("__headers" to true)
                (arg(0) as? Map<String, Any?>)?.forEach { (k, v) -> if (!k.startsWith("__")) h[k.lowercase()] = JSE.string(v) }
                return h
            }
            "Request" -> {
                val r = linkedMapOf<String, Any?>("__request" to true, "url" to "", "method" to "GET")
                val u = arg(0) as? Map<String, Any?>
                r["url"] = (u?.get("href") as? String) ?: str(0)
                (arg(1) as? Map<String, Any?>)?.let { opts ->
                    opts["method"]?.let { r["method"] = JSE.string(it) }
                    opts["headers"]?.let { r["headers"] = it }
                    opts["body"]?.let { r["body"] = it }
                    opts["signal"]?.let { r["signal"] = it }
                }
                return r
            }
            // ── Blob / File / FormData ──
            "Blob", "File" -> {
                val parts = (arg(0) as? List<Any?>) ?: emptyList()
                var data = ByteArray(0)
                for (p in parts) {
                    val d = blobData(p) ?: JSECrypto.data(p)
                    if (d != null) data += d
                }
                val optsIdx = if (name == "File") 2 else 1
                val opts = (arg(optsIdx) as? Map<String, Any?>) ?: emptyMap()
                val blob = linkedMapOf<String, Any?>(
                    "__blob" to Base64.getEncoder().encodeToString(data),
                    "type" to JSE.string(opts["type"] ?: ""), "size" to data.size.toDouble())
                if (name == "File") {
                    blob["name"] = str(1)
                    blob["lastModified"] = opts["lastModified"]?.let { JSE.number(it) } ?: System.currentTimeMillis().toDouble()
                }
                return blob
            }
            "FormData" -> return linkedMapOf<String, Any?>("__formdata" to listOf<Any?>())
            // ── Date ──
            "Date" -> {
                if (a.isEmpty()) return linkedMapOf<String, Any?>("__date" to System.currentTimeMillis().toDouble())
                if (a.size >= 2) return linkedMapOf<String, Any?>("__date" to dateFromComponents(a))
                return linkedMapOf<String, Any?>("__date" to parseDateMS(arg(0)))
            }
            "Date.now" -> return System.currentTimeMillis().toDouble()
            "Date.UTC" -> {
                // any non-finite provided arg → null (the TS twin's NaN-ms → null); huge
                // finite components can overflow the java.time rolls — caught, never a crash
                for (i in a.indices) { val v = JSE.number(a[i]); if (v != null && !v.isFinite()) return null }
                fun nn(i: Int, def: Double): Double = JSE.number(a.getOrNull(i)) ?: def
                return try {
                    val y = nn(0, 1970.0).toInt(); val mo = nn(1, 0.0).toLong(); val d = nn(2, 1.0).toLong()
                    var z = java.time.ZonedDateTime.of(y, 1, 1, 0, 0, 0, 0, java.time.ZoneOffset.UTC)
                    z = z.plusMonths(mo).plusDays(d - 1)
                        .plusHours(nn(3, 0.0).toLong()).plusMinutes(nn(4, 0.0).toLong())
                        .plusSeconds(nn(5, 0.0).toLong()).plusNanos(nn(6, 0.0).toLong() * 1_000_000)
                    z.toInstant().toEpochMilli().toDouble()
                } catch (_: Exception) { null }
            }
            "Date.parse" -> return parseDateMS(arg(0))
            // ── Intl ──
            "Intl.NumberFormat" -> return linkedMapOf<String, Any?>("__numfmt" to true, "locale" to str(0), "options" to ((arg(1) as? Map<String, Any?>) ?: emptyMap<String, Any?>()))
            "Intl.DateTimeFormat" -> return linkedMapOf<String, Any?>("__datefmt" to true, "locale" to str(0), "options" to ((arg(1) as? Map<String, Any?>) ?: emptyMap<String, Any?>()))
            "Intl.RelativeTimeFormat" -> return linkedMapOf<String, Any?>("__relfmt" to true, "locale" to str(0), "options" to ((arg(1) as? Map<String, Any?>) ?: emptyMap<String, Any?>()))
            // ── JSON / encoding ──
            "JSON.stringify" -> {
                val v = jsonSanitize(arg(0) ?: NSNull)
                val space = arg(2)?.let { JSE.number(it) } ?: 0.0
                return jsonWrite(v, pretty = space > 0, sortKeys = false)
            }
            "JSON.parse" -> {
                val obj = jsonParse(str(0))
                if (obj == INVALID_JSON) { kernelLog("[JSE core] JSON.parse: invalid"); return null }
                return obj
            }
            "encodeURIComponent" -> return percentEncode(str(0), keep = "-_.!~*'()")
            "encodeURI" -> return percentEncode(str(0), keep = "-_.!~*'();/?:@&=+$,#")
            "decodeURIComponent", "decodeURI" -> return percentDecode(str(0)) ?: str(0)
            // ── Object helpers ──
            "Object.keys" -> return (arg(0) as? Map<String, Any?>)?.keys?.filter { !it.startsWith("__") } ?: listOf<Any?>()
            "Object.values" -> {
                val d = arg(0) as? Map<String, Any?> ?: return listOf<Any?>()
                return d.entries.filter { !it.key.startsWith("__") }.map { it.value }
            }
            "Object.entries" -> {
                val d = arg(0) as? Map<String, Any?> ?: return listOf<Any?>()
                return d.entries.filter { !it.key.startsWith("__") }.map { listOf(it.key, it.value) }
            }
            "Object.assign" -> {   // value semantics: returns the MERGED dict (use x = Object.assign({}, x, y))
                val out = LinkedHashMap<String, Any?>()
                for (src in a) { (src as? Map<String, Any?>)?.let { out.putAll(it) } }
                return out
            }
            "Object.hasOwn" -> return (arg(0) as? Map<String, Any?>)?.containsKey(JSE.string(arg(1))) ?: false
            "Object.fromEntries" -> {
                val out = LinkedHashMap<String, Any?>()
                val entries = ((arg(0) as? Map<String, Any?>)?.get("__map") as? List<Any?>) ?: (arg(0) as? List<Any?>) ?: emptyList()
                for (e in entries) {
                    val pair = e as? List<Any?> ?: continue
                    val k = pair.firstOrNull() ?: continue
                    out[JSE.string(k)] = if (pair.size > 1) pair[1] else NSNull
                }
                return out
            }
            // ── console (kernelLog + the ring buffer the debugger reads) ──
            "console.log", "console.info", "console.debug", "console.warn", "console.error" -> {
                val level = name.substring(8)
                val line = formatLogArgs(a)   // the house formatter (Logs.kt; logs corpus)
                // the unified log ring (dsx.logs / the dev drawer) sees console.* too — the
                // builtin has no scheme of its own, so entries attribute as "console"
                DSXLogBuffer.shared.append(DSXLogEntry(scheme = "console", level = level, message = line))
                JSEConsole.append(level, line)
                return null
            }
            // ── Map / Set (value objects; add/set/delete are statements, like the rest) ──
            "Map" -> {
                val entries = ArrayList<Any?>()
                (arg(0) as? List<Any?>)?.forEach { e ->
                    val pair = e as? List<Any?>
                    if (pair != null && pair.size >= 2) entries.add(listOf(pair[0], pair[1]))
                }
                return linkedMapOf<String, Any?>("__map" to entries, "size" to entries.size.toDouble())
            }
            "Set" -> {
                val values = ArrayList<Any?>()
                (arg(0) as? List<Any?>)?.forEach { v -> if (!values.any { JSE.equals(it, v) }) values.add(v) }
                return linkedMapOf<String, Any?>("__set" to values, "size" to values.size.toDouble())
            }
            "WebSocket" -> {
                kernelLog("[JSE core] WebSocket is statement-only: const ws = new WebSocket(url[, { key }]) in an action body")
                return null
            }
            // ── RegExp (the literal form /…/flags tokenizes to the same value) ──
            "RegExp" -> return linkedMapOf<String, Any?>("__regex" to true, "source" to str(0), "flags" to str(1))
            // ── timing + errors ──
            "performance.now" -> return System.nanoTime() / 1_000_000.0
            "Error" -> return linkedMapOf<String, Any?>("__error" to true, "name" to "Error", "message" to JSE.string(arg(0)))
            // ── misc globals ──
            "structuredClone" -> return deepCopy(arg(0))
            "AbortController" -> {
                val id = UUID.randomUUID().toString()
                return linkedMapOf<String, Any?>("__controller" to id,
                    "signal" to linkedMapOf<String, Any?>("__signal" to id, "aborted" to false))
            }
            "parseInt" -> {
                val radix = arg(1)?.let { JSE.number(it) }?.toInt()
                return parseIntJS(str(0), radix)
            }
            "parseFloat" -> {
                val s = trimSpaces(str(0))
                val head = StringBuilder()
                for (ch in s) { if (ch.isDigit() || ch == '.' || ch == '-' || ch == '+' || ch == 'e' || ch == 'E') head.append(ch) else break }
                return JSE.number(head.toString()) ?: Double.NaN   // Swift Double(String) grammar
            }
            "isNaN" -> return (JSE.number(arg(0)) ?: Double.NaN).isNaN()
            "Number" -> return JSE.number(arg(0)) ?: Double.NaN
            "String" -> return JSE.string(arg(0))
            "Boolean" -> return JSE.truthy(arg(0))
            else -> {
                if (name.startsWith("Promise.")) {
                    kernelLog("[JSE core] $name is await-only: use `await $name([ … ])` as a statement")
                    return null
                }
                return null
            }
        }
    }

    // ── methods on JS-core dict shapes (expression position; Jse.kt's JSECore.method routes here
    //    after its RegExp `test` case). Returns null = "not mine". ──────────────────────────────
    fun method(m: String, d: Map<*, *>, a: List<Any?>): JSECore.Handled? {
        fun arg(i: Int): Any? = a.getOrNull(i)
        fun str(i: Int): String = JSE.string(arg(i))
        // URLSearchParams / FormData (entries lists)
        val entries = (d["__params"] as? List<Any?>) ?: (d["__formdata"] as? List<Any?>)
        if (entries != null) {
            val isParams = d["__params"] != null
            when (m) {
                "get" -> return JSECore.Handled(entries.mapNotNull { it as? List<Any?> }.firstOrNull { JSE.string(it.firstOrNull()) == str(0) }?.lastOrNull())
                "getAll" -> return JSECore.Handled(entries.mapNotNull { it as? List<Any?> }.filter { JSE.string(it.firstOrNull()) == str(0) }.mapNotNull { it.lastOrNull() })
                "has" -> return JSECore.Handled(entries.mapNotNull { it as? List<Any?> }.any { JSE.string(it.firstOrNull()) == str(0) })
                "toString" -> {
                    if (!isParams) return JSECore.Handled("[object FormData]")
                    return JSECore.Handled(encodeParams(entries))
                }
                "set", "append", "delete" ->    // expression position → the modified COPY (statement form persists)
                    return JSECore.Handled(mutate(m, d, a))
                else -> return null
            }
        }
        // Map / Set (value objects — get/has read; set/add/delete return modified copies here,
        // and PERSIST in statement form via the runner's mutation hook)
        (d["__map"] as? List<Any?>)?.let { mapEntries ->
            when (m) {
                "get" -> return JSECore.Handled(mapEntries.mapNotNull { it as? List<Any?> }.firstOrNull { JSE.equals(it.firstOrNull(), arg(0)) }?.lastOrNull())
                "has" -> return JSECore.Handled(mapEntries.mapNotNull { it as? List<Any?> }.any { JSE.equals(it.firstOrNull(), arg(0)) })
                "set", "delete" -> return JSECore.Handled(mutate(m, d, a))
                else -> return null
            }
        }
        (d["__set"] as? List<Any?>)?.let { setValues ->
            when (m) {
                "has" -> return JSECore.Handled(setValues.any { JSE.equals(it, arg(0)) })
                "add", "delete" -> return JSECore.Handled(mutate(m, d, a))
                else -> return null
            }
        }
        // Headers (plain lowercased keys + marker)
        if (d["__headers"] != null) {
            when (m) {
                "get" -> return JSECore.Handled(d[str(0)] ?: d[str(0).lowercase()])
                "has" -> return JSECore.Handled((d[str(0)] ?: d[str(0).lowercase()]) != null)
                "set", "append", "delete" -> return JSECore.Handled(mutate(m, d, a))
                else -> return null
            }
        }
        // fetch result (Response-shaped)
        if (d["__response"] != null) {
            when (m) {
                "json" -> return JSECore.Handled(d["data"])
                "text" -> return JSECore.Handled(d["text"] ?: "")
                else -> return null
            }
        }
        // Date
        val ms = d["__date"] as? Double
        if (ms != null) {
            val zdt = zonedDate(ms)
            when (m) {
                "getTime", "valueOf" -> return JSECore.Handled(ms)
                "toISOString", "toJSON" -> return JSECore.Handled(isoString(ms))
                "toString" -> return JSECore.Handled(stringCoerce(d as Map<String, Any?>) ?: "")
                "getFullYear" -> return JSECore.Handled(zdt.year.toDouble())
                "getMonth" -> return JSECore.Handled((zdt.monthValue - 1).toDouble())   // 0-based, like JS
                "getDate" -> return JSECore.Handled(zdt.dayOfMonth.toDouble())
                "getDay" -> return JSECore.Handled((zdt.dayOfWeek.value % 7).toDouble())  // 0 = Sunday
                "getHours" -> return JSECore.Handled(zdt.hour.toDouble())
                "getMinutes" -> return JSECore.Handled(zdt.minute.toDouble())
                "getSeconds" -> return JSECore.Handled(zdt.second.toDouble())
                "getMilliseconds" -> return JSECore.Handled((zdt.nano / 1_000_000).toDouble())
                "getUTCFullYear" -> return JSECore.Handled(utcDate(ms).year.toDouble())
                "getUTCMonth" -> return JSECore.Handled((utcDate(ms).monthValue - 1).toDouble())
                "getUTCDate" -> return JSECore.Handled(utcDate(ms).dayOfMonth.toDouble())
                "getUTCDay" -> return JSECore.Handled((utcDate(ms).dayOfWeek.value % 7).toDouble())
                "getUTCHours" -> return JSECore.Handled(utcDate(ms).hour.toDouble())
                "getUTCMinutes" -> return JSECore.Handled(utcDate(ms).minute.toDouble())
                "getUTCSeconds" -> return JSECore.Handled(utcDate(ms).second.toDouble())
                "getUTCMilliseconds" -> return JSECore.Handled((utcDate(ms).nano / 1_000_000).toDouble())
                "getTimezoneOffset" -> return JSECore.Handled((-zdt.offset.totalSeconds / 60).toDouble())
                "setTime", "setFullYear", "setMonth", "setDate", "setHours",
                "setMinutes", "setSeconds", "setMilliseconds" ->
                    // expression position returns the new ms; the STATEMENT route persists it
                    // through mutate() — the value-object mutation contract.
                    return JSECore.Handled(dateSetMS(ms, m, a))
                "toLocaleDateString", "toLocaleTimeString", "toLocaleString" -> {
                    val loc = (arg(0) as? String)?.takeIf { it.isNotEmpty() }?.let { jvmLocale(it) } ?: Locale.getDefault()
                    val f: DateFormat = when (m) {
                        "toLocaleDateString" -> DateFormat.getDateInstance(DateFormat.MEDIUM, loc)
                        "toLocaleTimeString" -> DateFormat.getTimeInstance(DateFormat.MEDIUM, loc)
                        else -> DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT, loc)
                    }
                    return JSECore.Handled(f.format(java.util.Date(epochMilli(ms))))
                }
                else -> return null
            }
        }
        // Intl formatters
        if (d["__numfmt"] != null && m == "format") {
            return JSECore.Handled(formatNumber(JSE.number(arg(0)) ?: Double.NaN,
                JSE.string(d["locale"]), (d["options"] as? Map<String, Any?>) ?: emptyMap()))
        }
        if (d["__datefmt"] != null && m == "format") {
            val dms = ((arg(0) as? Map<String, Any?>)?.get("__date") as? Double) ?: JSE.number(arg(0)) ?: 0.0
            return JSECore.Handled(formatDate(dms, JSE.string(d["locale"]), (d["options"] as? Map<String, Any?>) ?: emptyMap()))
        }
        if (d["__relfmt"] != null && m == "format") {
            return JSECore.Handled(formatRelative(JSE.number(arg(0)) ?: 0.0, str(1),
                JSE.string(d["locale"]), (d["options"] as? Map<String, Any?>) ?: emptyMap()))
        }
        // URL
        if (d["__url"] != null && (m == "toString" || m == "toJSON")) {
            return JSECore.Handled(d["href"] ?: "")
        }
        return null
    }

    /// `'' + date` / `{{ url }}` string coercion for the core shapes.
    fun stringCoerce(d: Map<String, Any?>): String? {
        (d["__date"] as? Double)?.let { return isoString(it) }
        if (d["__url"] != null) return d["href"] as? String
        (d["__params"] as? List<Any?>)?.let { return encodeParams(it) }
        if (d["__error"] != null) return JSE.string(d["name"] ?: "Error") + ": " + JSE.string(d["message"])
        if (d["__regex"] != null) return "/" + JSE.string(d["source"]) + "/" + JSE.string(d["flags"])
        return null
    }

    // ── statement-form mutation (the runner's read-modify-write hook; Swift `inout` → returned copy) ──
    val mutatingMethods: Set<String> = setOf("set", "append", "delete", "abort", "add",
        "setTime", "setFullYear", "setMonth", "setDate", "setHours", "setMinutes", "setSeconds", "setMilliseconds")
    fun canMutate(m: String, v: Any?): Boolean {
        val d = v as? Map<String, Any?> ?: return false
        if (m == "abort") return d["__controller"] != null
        if (m == "add") return d["__set"] != null
        if (m.startsWith("set") && m != "set") return d["__date"] != null   // the Date setters
        return d["__params"] != null || d["__formdata"] != null || d["__headers"] != null ||
            d["__map"] != null || d["__set"] != null
    }
    fun mutate(m: String, v: Any?, args: List<Any?>): Any? {
        val src = v as? Map<String, Any?> ?: return v
        val d = LinkedHashMap<String, Any?>(src)
        (d["__date"] as? Double)?.let { ms ->
            if (m.startsWith("set")) { d["__date"] = dateSetMS(ms, m, args); return d }
        }
        val key = JSE.string(args.firstOrNull())
        (d["__controller"] as? String)?.let { id ->
            if (m == "abort") {
                JSEAbortFlags.abort(id)
                (d["signal"] as? Map<String, Any?>)?.let { sig ->
                    val s = LinkedHashMap<String, Any?>(sig); s["aborted"] = true; d["signal"] = s
                }
                return d
            }
        }
        if (d["__headers"] != null) {
            when (m) {
                "set", "append" -> d[key.lowercase()] = JSE.string(args.getOrNull(1))
                "delete" -> d.remove(key.lowercase())
            }
            return d
        }
        // Map: keys are VALUES (JSE.equals), not strings — set replaces, delete removes; size maintained.
        (d["__map"] as? List<Any?>)?.let { old ->
            val entries = ArrayList(old)
            val k: Any? = args.firstOrNull()
            when (m) {
                "set" -> {
                    entries.removeAll { JSE.equals((it as? List<Any?>)?.firstOrNull(), k) }
                    entries.add(listOf(k ?: NSNull, if (args.size > 1) (args[1] ?: NSNull) else NSNull))
                }
                "delete" -> entries.removeAll { JSE.equals((it as? List<Any?>)?.firstOrNull(), k) }
            }
            d["__map"] = entries; d["size"] = entries.size.toDouble()
            return d
        }
        (d["__set"] as? List<Any?>)?.let { old ->
            val values = ArrayList(old)
            val k: Any? = args.firstOrNull()
            when (m) {
                "add" -> if (!values.any { JSE.equals(it, k) }) values.add(k ?: NSNull)
                "delete" -> values.removeAll { JSE.equals(it, k) }
            }
            d["__set"] = values; d["size"] = values.size.toDouble()
            return d
        }
        val listKey = if (d["__params"] != null) "__params" else "__formdata"
        val entries = ArrayList((d[listKey] as? List<Any?>) ?: emptyList())
        when (m) {
            "append" -> entries.add(listOf<Any?>(key, if (args.size > 1) (args[1] ?: "") else ""))
            "set" -> {
                val value: Any = if (args.size > 1) (args[1] ?: "") else ""
                entries.removeAll { ((it as? List<Any?>)?.firstOrNull())?.let { f -> JSE.string(f) == key } ?: false }
                entries.add(listOf<Any?>(key, value))
            }
            "delete" -> entries.removeAll { ((it as? List<Any?>)?.firstOrNull())?.let { f -> JSE.string(f) == key } ?: false }
        }
        d[listKey] = entries
        return d
    }
    fun aborted(id: String): Boolean = JSEAbortFlags.isAborted(id)

    // ── URL plumbing (hand-rolled RFC 3986 — Foundation-URLComponents-shaped; see header) ──
    private class RawURL(val scheme: String?, val authority: String?, var path: String, val query: String?, val fragment: String?)

    /// RFC 3986 appendix-B split; whitespace/control chars → invalid (URL(string:) behavior).
    private fun splitURL(s: String): RawURL? {
        if (s.isEmpty()) return null                              // URL(string: "") is nil
        if (s.any { it.code <= 0x20 || it.code == 0x7F }) return null
        val m = Regex("^(?:([A-Za-z][A-Za-z0-9+.\\-]*):)?(//[^/?#]*)?([^?#]*)(?:\\?([^#]*))?(?:#(.*))?$").matchEntire(s) ?: return null
        return RawURL(m.groups[1]?.value, m.groups[2]?.value?.removePrefix("//"),
            m.groupValues[3], m.groups[4]?.value, m.groups[5]?.value)
    }
    /// RFC 3986 §5.2.4 remove_dot_segments.
    private fun removeDotSegments(path: String): String {
        var input = path
        val output = StringBuilder()
        fun trimLast() {
            val idx = output.lastIndexOf("/")
            output.setLength(if (idx >= 0) idx else 0)
        }
        while (input.isNotEmpty()) {
            when {
                input.startsWith("../") -> input = input.substring(3)
                input.startsWith("./") -> input = input.substring(2)
                input.startsWith("/./") -> input = "/" + input.substring(3)
                input == "/." -> input = "/"
                input.startsWith("/../") -> { input = "/" + input.substring(4); trimLast() }
                input == "/.." -> { input = "/"; trimLast() }
                input == "." || input == ".." -> input = ""
                else -> {
                    val start = if (input.startsWith("/")) 1 else 0
                    val next = input.indexOf('/', start)
                    val seg = if (next >= 0) input.substring(0, next) else input
                    output.append(seg)
                    input = if (next >= 0) input.substring(next) else ""
                }
            }
        }
        return output.toString()
    }
    /// RFC 3986 §5.2.2 relative resolution (Foundation's algorithm).
    private fun resolveURL(refS: String, baseS: String): RawURL? {
        val ref = splitURL(refS) ?: return null
        val base = splitURL(baseS) ?: return null
        if (ref.scheme != null) { ref.path = removeDotSegments(ref.path); return ref }
        if (ref.authority != null) return RawURL(base.scheme, ref.authority, removeDotSegments(ref.path), ref.query, ref.fragment)
        if (ref.path.isEmpty()) {
            return RawURL(base.scheme, base.authority, base.path, ref.query ?: base.query, ref.fragment)
        }
        val merged = if (ref.path.startsWith("/")) ref.path
        else if (base.authority != null && base.path.isEmpty()) "/" + ref.path
        else base.path.substringBeforeLast("/", "") + "/" + ref.path
        return RawURL(base.scheme, base.authority, removeDotSegments(merged), ref.query, ref.fragment)
    }
    private fun recompose(u: RawURL): String {
        val sb = StringBuilder()
        u.scheme?.let { sb.append(it).append(":") }
        u.authority?.let { sb.append("//").append(it) }
        sb.append(u.path)
        u.query?.let { sb.append("?").append(it) }
        u.fragment?.let { sb.append("#").append(it) }
        return sb.toString()
    }
    private fun makeURL(input: String, base: String?): Map<String, Any?>? {
        val u = (if (base != null) resolveURL(input, base) else splitURL(input)) ?: return null
        val scheme = u.scheme ?: ""
        val auth = u.authority ?: ""
        // authority = [userinfo@]host[:port] (userinfo split like URLComponents)
        val hostPort = auth.substringAfterLast('@')
        val colon = hostPort.lastIndexOf(':')
        val hostname: String
        val port: String
        if (colon >= 0 && hostPort.substring(colon + 1).all { it.isDigit() } && !hostPort.endsWith("]")) {
            hostname = hostPort.substring(0, colon); port = hostPort.substring(colon + 1)
        } else { hostname = hostPort; port = "" }
        val host = hostname + (if (port.isEmpty()) "" else ":$port")
        val entries = ArrayList<Any?>()
        for (pair in (u.query ?: "").split("&")) {   // queryItems: percent-decoded, NOT form-aware ('+' stays)
            if (pair.isEmpty()) continue
            val eq = pair.indexOf('=')
            val k = if (eq >= 0) pair.substring(0, eq) else pair
            val v = if (eq >= 0) pair.substring(eq + 1) else ""
            entries.add(listOf<Any?>(percentDecode(k) ?: k, percentDecode(v) ?: v))
        }
        return linkedMapOf<String, Any?>(
            "__url" to true,
            "href" to recompose(u),
            "protocol" to "$scheme:",
            "hostname" to hostname, "port" to port, "host" to host,
            "origin" to (if (scheme.isEmpty() || hostname.isEmpty()) "" else "$scheme://$host"),
            "pathname" to (u.path.ifEmpty { "/" }),
            "search" to (if (!u.query.isNullOrEmpty()) "?" + u.query else ""),
            "hash" to (if (!u.fragment.isNullOrEmpty()) "#" + (percentDecode(u.fragment) ?: u.fragment) else ""),
            "searchParams" to linkedMapOf<String, Any?>("__params" to entries))
    }
    /// After a searchParams mutation: rebuild `search` + `href` from the entries.
    fun resyncURL(d: Map<String, Any?>): Map<String, Any?> {
        val out = LinkedHashMap<String, Any?>(d)
        val entries = ((d["searchParams"] as? Map<String, Any?>)?.get("__params") as? List<Any?>) ?: emptyList()
        val query = encodeParams(entries)
        val href = (d["href"] as? String) ?: ""
        val u = splitURL(href) ?: return out
        out["search"] = if (query.isEmpty()) "" else "?$query"
        out["href"] = recompose(RawURL(u.scheme, u.authority, u.path, if (query.isEmpty()) null else query, u.fragment))
        return out
    }
    private fun parseParams(v: Any?): List<Any?> {
        val entries = ArrayList<Any?>()
        when (v) {
            is String -> {
                val body = if (v.startsWith("?")) v.substring(1) else v
                for (pair in body.split("&")) {
                    if (pair.isEmpty()) continue
                    val eq = pair.indexOf('=')
                    val k = if (eq >= 0) pair.substring(0, eq) else pair
                    val value = if (eq >= 0) pair.substring(eq + 1) else ""
                    entries.add(listOf<Any?>(formDecode(k), formDecode(value)))
                }
            }
            is Map<*, *> -> for ((k, value) in v) {
                val ks = k as? String ?: continue
                if (!ks.startsWith("__")) entries.add(listOf<Any?>(ks, JSE.string(value)))
            }
            is List<*> -> for (e in v) {
                val pair = e as? List<Any?> ?: continue
                if (pair.size >= 2) entries.add(listOf<Any?>(JSE.string(pair[0]), JSE.string(pair[1])))
            }
        }
        return entries
    }
    /// application/x-www-form-urlencoded (the URLSearchParams contract: space → '+').
    fun encodeParams(entries: List<Any?>): String =
        entries.mapNotNull { e ->
            val pair = e as? List<Any?> ?: return@mapNotNull null
            val k = pair.firstOrNull() ?: return@mapNotNull null
            formEncode(JSE.string(k)) + "=" + formEncode(JSE.string(if (pair.size > 1) pair[1] else ""))
        }.joinToString("&")
    private fun formEncode(s: String): String {
        val out = StringBuilder()
        for (b in s.toByteArray(Charsets.UTF_8)) {
            val c = (b.toInt() and 0xFF).toChar()
            if ((c in 'a'..'z') || (c in 'A'..'Z') || (c in '0'..'9') || c in "-._*") out.append(c)
            else if (c == ' ') out.append('+')
            else out.append('%').append(String.format("%02X", b.toInt() and 0xFF))
        }
        return out.toString()
    }
    private fun formDecode(s: String): String = percentDecode(s.replace("+", " ")) ?: s
    private fun percentEncode(s: String, keep: String): String {
        val out = StringBuilder()
        for (b in s.toByteArray(Charsets.UTF_8)) {
            val c = (b.toInt() and 0xFF).toChar()
            if ((c in 'a'..'z') || (c in 'A'..'Z') || (c in '0'..'9') || keep.contains(c)) out.append(c)
            else out.append('%').append(String.format("%02X", b.toInt() and 0xFF))
        }
        return out.toString()
    }
    /// removingPercentEncoding: full %XX decode over UTF-8 bytes; malformed/invalid → null.
    fun percentDecode(s: String): String? {
        if (!s.contains('%')) return s
        val bytes = java.io.ByteArrayOutputStream()
        var i = 0
        val raw = s.toByteArray(Charsets.UTF_8)
        while (i < raw.size) {
            val c = raw[i].toInt() and 0xFF
            if (c == '%'.code) {
                if (i + 2 >= raw.size) return null
                val hi = Character.digit(raw[i + 1].toInt().toChar(), 16)
                val lo = Character.digit(raw[i + 2].toInt().toChar(), 16)
                if (hi < 0 || lo < 0) return null
                bytes.write(hi * 16 + lo)
                i += 3
            } else { bytes.write(c); i += 1 }
        }
        val decoded = bytes.toByteArray()
        val out = String(decoded, Charsets.UTF_8)
        // invalid UTF-8 → nil on Foundation (replacement chars mean the bytes didn't round-trip)
        if (!decoded.contentEquals(out.toByteArray(Charsets.UTF_8))) return null
        return out
    }

    // ── fetch body plumbing (shared with the runner's fetchOp; wave 3 consumes) ───────────
    fun applyHeaders(v: Any?, headers: MutableMap<String, String>) {
        val h = v as? Map<String, Any?> ?: return
        for ((k, value) in h) if (!k.startsWith("__")) headers[k] = JSE.string(value)
    }
    private fun hasContentType(headers: Map<String, String>): Boolean =
        headers.keys.any { it.lowercase() == "content-type" }
    fun bodyData(v: Any?, headers: MutableMap<String, String>): ByteArray? {
        if (v == null) return null
        if (v is String) {                                          // JSON.stringify output / raw text
            if (!hasContentType(headers)) headers["Content-Type"] = "text/plain;charset=UTF-8"
            return v.toByteArray(Charsets.UTF_8)
        }
        if (v is Map<*, *>) {
            val d = v as Map<String, Any?>
            (d["__formdata"] as? List<Any?>)?.let { return multipart(it, headers) }
            (d["__blob"] as? String)?.let { b64 ->
                if (!hasContentType(headers)) (d["type"] as? String)?.takeIf { it.isNotEmpty() }?.let { headers["Content-Type"] = it }
                return try { Base64.getDecoder().decode(b64) } catch (_: Exception) { null }
            }
            if (d["__params"] != null) {
                val entries = d["__params"] as? List<Any?> ?: emptyList()
                if (!hasContentType(headers)) headers["Content-Type"] = "application/x-www-form-urlencoded;charset=UTF-8"
                return encodeParams(entries).toByteArray(Charsets.UTF_8)
            }
            return jsonWrite(jsonSanitize(d), pretty = false, sortKeys = false)?.toByteArray(Charsets.UTF_8)
        }
        if (v is List<*>) return jsonWrite(jsonSanitize(v), pretty = false, sortKeys = false)?.toByteArray(Charsets.UTF_8)
        return null
    }
    private fun blobData(v: Any?): ByteArray? {
        val b64 = (v as? Map<String, Any?>)?.get("__blob") as? String ?: return null
        return try { Base64.getDecoder().decode(b64) } catch (_: Exception) { null }
    }
    private fun multipart(entries: List<Any?>, headers: MutableMap<String, String>): ByteArray {
        val boundary = "dsx-" + UUID.randomUUID().toString()
        headers.keys.filter { it.lowercase() == "content-type" }.forEach { headers.remove(it) }
        headers["Content-Type"] = "multipart/form-data; boundary=$boundary"
        val d = java.io.ByteArrayOutputStream()
        fun ap(s: String) = d.write(s.toByteArray(Charsets.UTF_8))
        for (e in entries) {
            val pair = e as? List<Any?> ?: continue
            if (pair.size < 2) continue
            val name = JSE.string(pair[0])
            ap("--$boundary\r\n")
            val f = pair[1] as? Map<String, Any?>
            val b64 = f?.get("__blob") as? String
            if (f != null && b64 != null) {
                val filename = (f["name"] as? String) ?: "blob"
                val typeStr = (f["type"] as? String)?.takeIf { it.isNotEmpty() } ?: "application/octet-stream"
                ap("Content-Disposition: form-data; name=\"$name\"; filename=\"$filename\"\r\n")
                ap("Content-Type: $typeStr\r\n\r\n")
                d.write(try { Base64.getDecoder().decode(b64) } catch (_: Exception) { ByteArray(0) })
                ap("\r\n")
            } else {
                ap("Content-Disposition: form-data; name=\"$name\"\r\n\r\n")
                ap(JSE.string(pair[1]))
                ap("\r\n")
            }
        }
        ap("--$boundary--\r\n")
        return d.toByteArray()
    }

    /// JS parseInt: trims, optional sign, optional 0x (radix 16), parses the LEADING digits
    /// in `radix` (default 10) and ignores the rest; nothing parseable → NaN.
    private fun parseIntJS(s: String, radix: Int?): Double {
        var str = trimSpaces(s)
        var sign = 1.0
        if (str.startsWith("-")) { sign = -1.0; str = str.substring(1) } else if (str.startsWith("+")) str = str.substring(1)
        var r = radix ?: 10
        if ((r == 16 || radix == null) && str.lowercase().startsWith("0x")) { str = str.substring(2); r = 16 }
        if (r !in 2..36) return Double.NaN
        val head = StringBuilder()
        for (ch in str.lowercase()) {
            val v: Int = when {
                ch.isDigit() -> ch.digitToIntOrNull() ?: break     // Unicode Nd → value (Swift wholeNumberValue)
                ch.isLetter() && ch.code in 97..122 -> ch.code - 97 + 10
                else -> break
            }
            if (v >= r) break
            head.append(ch)
        }
        if (head.isEmpty()) return Double.NaN
        val n = head.toString().toLongOrNull(r) ?: return Double.NaN   // Swift Int(head, radix:) — overflow/Unicode → NaN
        return sign * n.toDouble()
    }
    /// Swift .whitespaces (spaces + tabs, no newlines).
    private fun trimSpaces(s: String): String = s.trim { it == '\t' || it.category == CharCategory.SPACE_SEPARATOR }

    // ── Date plumbing ─────────────────────────────────────────────────────────────────────
    fun parseDateMS(v: Any?): Double {
        ((v as? Map<String, Any?>)?.get("__date") as? Double)?.let { return it }   // new Date(date) = copy
        if (v is Double) return v
        if (v is Int) return v.toDouble()
        val s = v as? String
        if (s == null || s.isEmpty()) return JSE.number(v) ?: Double.NaN
        // ISO date-time WITH zone (fractional or not) — the two ISO8601DateFormatter passes
        try { return java.time.OffsetDateTime.parse(s).toInstant().toEpochMilli().toDouble() } catch (_: Exception) {}
        try { return LocalDate.parse(s).atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli().toDouble() } catch (_: Exception) {}
        try {
            val f = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss")
            return LocalDateTime.parse(s, f).atZone(ZoneId.systemDefault()).toInstant().toEpochMilli().toDouble()
        } catch (_: Exception) {}
        try {
            val f = DateTimeFormatter.ofPattern("yyyy/MM/dd")
            return LocalDate.parse(s, f).atStartOfDay(ZoneId.systemDefault()).toInstant().toEpochMilli().toDouble()
        } catch (_: Exception) {}
        return Double.NaN
    }
    private fun epochMilli(ms: Double): Long = if (ms.isFinite()) ms.toLong() else 0L   // NaN dates stay total
    private fun zonedDate(ms: Double): ZonedDateTime =
        Instant.ofEpochMilli(epochMilli(ms)).atZone(ZoneId.systemDefault())            // JS getters are LOCAL time
    private fun utcDate(ms: Double): ZonedDateTime =
        Instant.ofEpochMilli(epochMilli(ms)).atZone(java.time.ZoneOffset.UTC)          // getUTC* getters
    /// new Date(year, month0[, day[, h[, m[, s[, ms]]]]]) — LOCAL time, rolled through
    /// java.time like dateSetMS. Any non-finite component → an invalid date (NaN ms);
    /// huge finite components overflow the rolls — caught, never a crash (F7/F20).
    fun dateFromComponents(a: List<Any?>): Double {
        val defs = doubleArrayOf(1970.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0)
        val vals = DoubleArray(7)
        for (i in 0 until 7) {
            if (i < a.size) {
                val n = JSE.number(a[i]) ?: Double.NaN
                if (!n.isFinite()) return Double.NaN
                vals[i] = n
            } else vals[i] = defs[i]
        }
        return try {
            var z = java.time.ZonedDateTime.of(vals[0].toInt(), 1, 1, 0, 0, 0, 0, ZoneId.systemDefault())
            z = z.plusMonths(vals[1].toLong()).plusDays(vals[2].toLong() - 1)
                .plusHours(vals[3].toLong()).plusMinutes(vals[4].toLong())
                .plusSeconds(vals[5].toLong()).plusNanos(vals[6].toLong() * 1_000_000)
            z.toInstant().toEpochMilli().toDouble()
        } catch (_: Exception) { Double.NaN }
    }

    /// Local-time Date setter arithmetic — replace the named components (delta-based, so
    /// out-of-range values roll like JS on the common paths), return new ms. TOTAL:
    /// NaN component deltas degrade (toLong() → 0), huge deltas overflow the java.time
    /// rolls — caught, the ms rides through unchanged instead of a crash (F20).
    fun dateSetMS(ms: Double, m: String, a: List<Any?>): Double {
        fun nn(i: Int): Double? = if (i < a.size) JSE.number(a[i]) else null
        if (m == "setTime") return nn(0) ?: 0.0
        return try { dateSetMSBody(ms, m, ::nn) } catch (_: Exception) { ms }
    }

    private fun dateSetMSBody(ms: Double, m: String, nn: (Int) -> Double?): Double {
        var z = zonedDate(ms)
        when (m) {
            "setFullYear" -> {
                z = z.plusYears((nn(0) ?: z.year.toDouble()).toLong() - z.year)
                nn(1)?.let { z = z.plusMonths(it.toLong() + 1 - z.monthValue) }
                nn(2)?.let { z = z.plusDays(it.toLong() - z.dayOfMonth) }
            }
            "setMonth" -> {
                z = z.plusMonths((nn(0) ?: (z.monthValue - 1).toDouble()).toLong() + 1 - z.monthValue)
                nn(1)?.let { z = z.plusDays(it.toLong() - z.dayOfMonth) }
            }
            "setDate" -> z = z.plusDays((nn(0) ?: z.dayOfMonth.toDouble()).toLong() - z.dayOfMonth)
            "setHours" -> {
                z = z.plusHours((nn(0) ?: z.hour.toDouble()).toLong() - z.hour)
                nn(1)?.let { z = z.plusMinutes(it.toLong() - z.minute) }
                nn(2)?.let { z = z.plusSeconds(it.toLong() - z.second) }
                nn(3)?.let { z = z.plusNanos((it.toLong() - z.nano / 1_000_000) * 1_000_000) }
            }
            "setMinutes" -> {
                z = z.plusMinutes((nn(0) ?: z.minute.toDouble()).toLong() - z.minute)
                nn(1)?.let { z = z.plusSeconds(it.toLong() - z.second) }
                nn(2)?.let { z = z.plusNanos((it.toLong() - z.nano / 1_000_000) * 1_000_000) }
            }
            "setSeconds" -> {
                z = z.plusSeconds((nn(0) ?: z.second.toDouble()).toLong() - z.second)
                nn(1)?.let { z = z.plusNanos((it.toLong() - z.nano / 1_000_000) * 1_000_000) }
            }
            "setMilliseconds" -> z = z.plusNanos(((nn(0) ?: (z.nano / 1_000_000).toDouble()).toLong() - z.nano / 1_000_000) * 1_000_000)
        }
        return z.toInstant().toEpochMilli().toDouble()
    }
    /// toISOString/toJSON — UTC, always exactly 3 fraction digits.
    fun isoString(ms: Double): String =
        DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'")
            .format(Instant.ofEpochMilli(epochMilli(ms)).atZone(ZoneOffset.UTC))

    // ── Intl formatting (java.text — see the header's pinned decisions) ───────────────────
    private fun jvmLocale(id: String): Locale =
        if (id.isEmpty()) Locale.getDefault() else Locale.forLanguageTag(id.replace('_', '-'))
    private fun formatNumber(n: Double, locale: String, options: Map<String, Any?>): String {
        val loc = jvmLocale(locale)
        val f: NumberFormat = when (JSE.string(options["style"])) {
            "currency" -> {
                val cf = NumberFormat.getCurrencyInstance(loc)
                val code = JSE.string(options["currency"])
                if (code.isNotEmpty()) try { cf.currency = Currency.getInstance(code) } catch (_: Exception) {}
                cf
            }
            "percent" -> NumberFormat.getPercentInstance(loc)
            else -> NumberFormat.getNumberInstance(loc)
        }
        options["minimumFractionDigits"]?.let { JSE.number(it) }?.let { f.minimumFractionDigits = it.toInt() }
        options["maximumFractionDigits"]?.let { JSE.number(it) }?.let { f.maximumFractionDigits = it.toInt() }
        options["useGrouping"]?.let { f.isGroupingUsed = JSE.truthy(it) }
        return try { f.format(n) } catch (_: Exception) { JSE.string(n) }
    }
    private fun formatDate(ms: Double, locale: String, options: Map<String, Any?>): String {
        val loc = jvmLocale(locale)
        val date = java.util.Date(epochMilli(ms))
        fun style(s: String): Int? = when (s) {
            "full" -> DateFormat.FULL; "long" -> DateFormat.LONG
            "medium" -> DateFormat.MEDIUM; "short" -> DateFormat.SHORT; else -> null
        }
        val ds = style(JSE.string(options["dateStyle"])); val ts = style(JSE.string(options["timeStyle"]))
        if (ds != null || ts != null) {
            val f = when {
                ds != null && ts != null -> DateFormat.getDateTimeInstance(ds, ts, loc)
                ds != null -> DateFormat.getDateInstance(ds, loc)
                else -> DateFormat.getTimeInstance(ts!!, loc)
            }
            return f.format(date)
        }
        // Component options → a pattern (no DateTimePatternGenerator on the JVM — order/
        // separators derive from the locale's SHORT patterns; documented approximation).
        fun opt(key: String, map: Map<String, String>): String? = map[JSE.string(options[key])]
        val weekday = opt("weekday", mapOf("narrow" to "EEEEE", "short" to "EEE", "long" to "EEEE"))
        val year = opt("year", mapOf("numeric" to "yyyy", "2-digit" to "yy"))
        val month = opt("month", mapOf("numeric" to "M", "2-digit" to "MM", "narrow" to "MMMMM", "short" to "MMM", "long" to "MMMM"))
        val day = opt("day", mapOf("numeric" to "d", "2-digit" to "dd"))
        val hour = opt("hour", mapOf("numeric" to "j", "2-digit" to "jj"))
        val minute = opt("minute", mapOf("numeric" to "m", "2-digit" to "mm"))
        val second = opt("second", mapOf("numeric" to "s", "2-digit" to "ss"))
        if (weekday == null && year == null && month == null && day == null && hour == null && minute == null && second == null) {
            return DateFormat.getDateInstance(DateFormat.SHORT, loc).format(date)   // JS default: numeric date
        }
        val shortDate = (DateFormat.getDateInstance(DateFormat.SHORT, loc) as? SimpleDateFormat)?.toPattern() ?: "M/d/yy"
        val order = shortDate.filter { it in "yMd" }.toCharArray().distinct()       // locale field order
        val sep = shortDate.firstOrNull { it in "./-" } ?: '/'
        val textualMonth = month != null && month.length >= 3
        val fields = LinkedHashMap<Char, String>()
        year?.let { fields['y'] = it }; month?.let { fields['M'] = it }; day?.let { fields['d'] = it }
        val ordered = order.mapNotNull { fields[it] } + fields.filterKeys { it !in order }.values
        var datePart = when {
            ordered.isEmpty() -> ""
            !textualMonth -> ordered.joinToString(sep.toString())
            // textual month: "MMMM d, yyyy" (M-before-d locales) / "d MMMM yyyy" — approximation
            order.indexOf('M') < 0 || order.indexOf('d') < 0 || order.indexOf('M') < order.indexOf('d') -> {
                val md = listOfNotNull(month, day).joinToString(" ")
                if (year == null) md else if (md.isEmpty()) year else "$md, $year"
            }
            else -> listOfNotNull(day, month, year).joinToString(" ")
        }
        weekday?.let { datePart = if (datePart.isEmpty()) it else "$it, $datePart" }
        var timePart = ""
        if (hour != null || minute != null || second != null) {
            val shortTime = (DateFormat.getTimeInstance(DateFormat.SHORT, loc) as? SimpleDateFormat)?.toPattern() ?: "h:mm a"
            val h24 = shortTime.contains('H')
            val hourPat = hour?.replace("jj", if (h24) "HH" else "hh")?.replace("j", if (h24) "H" else "h")
            timePart = listOfNotNull(hourPat, minute, second).joinToString(":")
            if (!h24 && hour != null) timePart += " a"
        }
        val pattern = listOf(datePart, timePart).filter { it.isNotEmpty() }.joinToString(", ")
        return try { SimpleDateFormat(pattern, loc).format(date) } catch (_: Exception) { date.toString() }
    }
    /// English-only CLDR-shaped fallback (RelativeDateTimeFormatter has no JVM twin — ICU
    /// rides :platform). numeric:'auto' names the near cases like .named does.
    private fun formatRelative(value: Double, unit: String, locale: String, options: Map<String, Any?>): String {
        val v = value.toInt()
        val u = if (unit.endsWith("s")) unit.dropLast(1) else unit
        val named = JSE.string(options["numeric"]) == "auto"
        val norm = if (u == "quarter") "month" else u
        val n = if (u == "quarter") v * 3 else v
        if (named) {
            if (norm == "day") when (n) { -1 -> return "yesterday"; 0 -> return "today"; 1 -> return "tomorrow" }
            if (norm == "second" && n == 0) return "now"
        }
        val plural = if (kotlin.math.abs(n) == 1) norm else norm + "s"
        return if (n < 0) "${-n} $plural ago" else "in $n $plural"
    }

    // ── JSON sanitize + deep copy ─────────────────────────────────────────────────────────
    /// JSON.stringify / fetch-body view of core shapes: Date → ISO (its toJSON), URL → href,
    /// URLSearchParams → query string, Blob → null; "__" marker keys never serialize.
    fun jsonSanitize(v: Any): Any {
        if (v is Map<*, *>) {
            val d = v as Map<String, Any?>
            (d["__date"] as? Double)?.let { return isoString(it) }
            if (d["__url"] != null) return d["href"] ?: ""
            (d["__params"] as? List<Any?>)?.let { return encodeParams(it) }
            if (d["__blob"] != null || d["__formdata"] != null) return NSNull
            val out = LinkedHashMap<String, Any?>()
            for ((k, value) in d) if (!k.startsWith("__")) out[k] = value?.let { jsonSanitize(it) }
            return out
        }
        if (v is List<*>) return v.map { it?.let { e -> jsonSanitize(e) } }
        return v
    }
    fun deepCopy(v: Any?): Any {
        if (v == null) return NSNull
        if (v is Map<*, *>) {
            val out = LinkedHashMap<String, Any?>()
            for ((k, value) in v as Map<String, Any?>) out[k] = deepCopy(value)
            return out
        }
        if (v is List<*>) return v.map { deepCopy(it) }
        return v
    }

    // ── JSON writer/reader (JSONSerialization-shaped — see the header's pinned decisions) ──
    /// Serialize; null = "not valid JSON" (Foundation's throw → `try?` nil). Escapes '/'.
    fun jsonWrite(v: Any?, pretty: Boolean, sortKeys: Boolean): String? {
        val sb = StringBuilder()
        return try { writeJSON(v, sb, if (pretty) 0 else -1, sortKeys); sb.toString() } catch (_: Exception) { null }
    }
    private fun writeJSON(v: Any?, out: StringBuilder, indent: Int, sortKeys: Boolean) {
        when (v) {
            null, NSNull -> out.append("null")
            is Boolean -> out.append(if (v) "true" else "false")
            is Double -> {
                if (!v.isFinite()) throw IllegalArgumentException("non-finite")
                if (v == Math.floor(v) && kotlin.math.abs(v) < 9.223372036854776E18) out.append(v.toLong())
                else out.append(v)   // shortest round-trip (exotic forms are non-contractual)
            }
            is Int, is Long -> out.append(v)
            is Number -> writeJSON(v.toDouble(), out, indent, sortKeys)
            is String -> writeJSONString(v, out)
            is Map<*, *> -> {
                val keys = v.keys.map { it as? String ?: throw IllegalArgumentException("non-string key") }
                val ordered = if (sortKeys) keys.sorted() else keys
                out.append('{')
                var first = true
                for (k in ordered) {
                    if (!first) out.append(',')
                    first = false
                    if (indent >= 0) { out.append('\n'); repeat(indent + 1) { out.append("  ") } }
                    writeJSONString(k, out)
                    out.append(if (indent >= 0) " : " else ":")
                    writeJSON(v[k], out, if (indent >= 0) indent + 1 else -1, sortKeys)
                }
                if (indent >= 0 && !first) { out.append('\n'); repeat(indent) { out.append("  ") } }
                out.append('}')
            }
            is List<*> -> {
                out.append('[')
                var first = true
                for (e in v) {
                    if (!first) out.append(',')
                    first = false
                    if (indent >= 0) { out.append('\n'); repeat(indent + 1) { out.append("  ") } }
                    writeJSON(e, out, if (indent >= 0) indent + 1 else -1, sortKeys)
                }
                if (indent >= 0 && !first) { out.append('\n'); repeat(indent) { out.append("  ") } }
                out.append(']')
            }
            else -> throw IllegalArgumentException("not JSON: $v")   // lambdas/foreign objects → nil
        }
    }
    private fun writeJSONString(s: String, out: StringBuilder) {
        out.append('"')
        for (c in s) when {
            c == '"' -> out.append("\\\"")
            c == '\\' -> out.append("\\\\")
            c == '/' -> out.append("\\/")           // JSONSerialization default (no .withoutEscapingSlashes)
            c == '\n' -> out.append("\\n")
            c == '\r' -> out.append("\\r")
            c == '\t' -> out.append("\\t")
            c < ' ' -> out.append("\\u").append(c.code.toString(16).padStart(4, '0'))
            else -> out.append(c)
        }
        out.append('"')
    }

    /// Sentinel: jsonParse's "invalid" (valid `null` parses to NSNull, so null can't mean failure).
    val INVALID_JSON = Any()
    /// JSONSerialization(.fragmentsAllowed)-shaped reader: numbers → Double (the JSE number
    /// model), null → NSNull (present-but-null), invalid syntax → INVALID_JSON.
    fun jsonParse(s: String): Any? = try { JSONReader(s).parse() } catch (_: Exception) { INVALID_JSON }

    private class JSONReader(private val s: String) {
        private var i = 0
        private var depth = 0
        fun parse(): Any? {
            val v = readValue(); skipWS()
            require(i == s.length) { "trailing" }
            return v
        }
        private fun readValue(): Any? {
            require(++depth <= 512) { "deep" }
            skipWS()
            val v: Any? = when (peek()) {
                '{' -> readObject(); '[' -> readArray(); '"' -> readString()
                't' -> lit("true", true); 'f' -> lit("false", false); 'n' -> lit("null", NSNull)
                else -> readNumber()
            }
            depth--
            return v
        }
        private fun lit(t: String, v: Any?): Any? { require(s.startsWith(t, i)) { "lit" }; i += t.length; return v }
        private fun readObject(): Map<String, Any?> {
            i++
            val o = LinkedHashMap<String, Any?>()
            skipWS()
            if (peek() == '}') { i++; return o }
            while (true) {
                skipWS(); require(peek() == '"') { "key" }
                val key = readString()
                skipWS(); require(peek() == ':') { ":" }; i++
                o[key] = readValue()
                skipWS()
                when (peek()) { ',' -> i++; '}' -> { i++; return o }; else -> throw IllegalArgumentException(",}") }
            }
        }
        private fun readArray(): List<Any?> {
            i++
            val a = ArrayList<Any?>()
            skipWS()
            if (peek() == ']') { i++; return a }
            while (true) {
                a.add(readValue()); skipWS()
                when (peek()) { ',' -> i++; ']' -> { i++; return a }; else -> throw IllegalArgumentException(",]") }
            }
        }
        private fun readString(): String {
            i++
            val out = StringBuilder()
            while (true) {
                require(i < s.length) { "eof" }
                when (val c = s[i++]) {
                    '"' -> return out.toString()
                    '\\' -> out.append(readEscape())
                    else -> { require(c >= ' ') { "ctl" }; out.append(c) }
                }
            }
        }
        private fun readEscape(): Char {
            require(i < s.length) { "esc" }
            return when (s[i++]) {
                '"' -> '"'; '\\' -> '\\'; '/' -> '/'; 'b' -> '\b'; 'f' -> '\u000C'
                'n' -> '\n'; 'r' -> '\r'; 't' -> '\t'
                'u' -> {
                    require(i + 4 <= s.length) { "u" }
                    val hex = s.substring(i, i + 4)
                    require(hex.all { it in '0'..'9' || it in 'a'..'f' || it in 'A'..'F' }) { "u" }
                    i += 4
                    hex.toInt(16).toChar()
                }
                else -> throw IllegalArgumentException("esc")
            }
        }
        private fun readNumber(): Double {
            val start = i
            if (peek() == '-') i++
            require(i < s.length && s[i] in '0'..'9') { "num" }
            if (s[i] == '0') i++ else while (i < s.length && s[i] in '0'..'9') i++
            if (i < s.length && s[i] == '.') {
                i++; require(i < s.length && s[i] in '0'..'9') { "frac" }
                while (i < s.length && s[i] in '0'..'9') i++
            }
            if (i < s.length && (s[i] == 'e' || s[i] == 'E')) {
                i++
                if (i < s.length && (s[i] == '+' || s[i] == '-')) i++
                require(i < s.length && s[i] in '0'..'9') { "exp" }
                while (i < s.length && s[i] in '0'..'9') i++
            }
            return s.substring(start, i).toDouble()
        }
        private fun peek(): Char { require(i < s.length) { "eof" }; return s[i] }
        private fun skipWS() { while (i < s.length && s[i] in " \t\n\r") i++ }
    }
}

/// Process-global abort flags (`AbortController` ids). The signal dict carries the id; an
/// in-flight fetch checks the flag when it settles — abort = the result is discarded and
/// `{ ok:false, error:'aborted' }` lands instead.
internal object JSEAbortFlags {
    private val lock = Any()
    private val ids = HashSet<String>()
    fun abort(id: String) = synchronized(lock) { ids.add(id); Unit }
    fun isAborted(id: String): Boolean = synchronized(lock) { ids.contains(id) }
}

/// `console.*` sink: kernelLog (the NSLog twin) + a bounded ring buffer the debugger/
/// inspector reads. Process-global, lock-guarded, capped — logging can never grow
/// memory unbounded or crash a surface.
internal object JSEConsole {
    private val lock = Any()
    private val buffer = ArrayList<String>()
    private const val cap = 500
    val lines: List<String> get() = synchronized(lock) { ArrayList(buffer) }
    fun append(level: String, message: String) {
        kernelLog("[DSX console] $level: $message")
        synchronized(lock) {
            buffer.add("$level: $message")
            if (buffer.size > cap) buffer.subList(0, buffer.size - cap).clear()
        }
    }
}

/// Log redaction — any value whose KEY looks like a credential masks to "•••" before it
/// reaches console/trace output. Applied recursively to dicts/arrays at serialization time —
/// the live values in the store are untouched. The key list is part of the cross-platform
/// contract (js-core-parity: keep the lists identical).
internal object JSERedact {
    private val sensitive = listOf("token", "secret", "password", "passwd", "authorization",
        "cookie", "apikey", "api_key", "api-key", "bearer",
        "credential", "session_id", "sessionid", "private_key", "privatekey")
    fun isSensitive(key: String): Boolean {
        val k = key.lowercase()
        return sensitive.any { k == it || k.endsWith("_$it") || (k.endsWith(it) && it.length > 5) }
    }
    fun mask(v: Any): Any {
        if (v is Map<*, *>) {
            val out = LinkedHashMap<String, Any?>()
            for ((k, value) in v as Map<String, Any?>) out[k] = if (isSensitive(k)) "•••" else value?.let { mask(it) }
            return out
        }
        if (v is List<*>) return v.map { it?.let { e -> mask(e) } }
        return v
    }
    /// Mask credential-looking QUERY values in a URL for logging (`?token=…` → `?token=•••`).
    fun maskURL(url: String): String {
        if (!url.contains("?")) return url
        return url.replace(Regex("([?&](?:token|secret|password|authorization|cookie|api[_-]?key|bearer|credential|session_id|key)=)[^&#]*",
            RegexOption.IGNORE_CASE), "$1•••")
    }
}

// MARK: - JSECryptoGlobals (the Stack.swift JSECrypto implementation; Jse.kt's JSECrypto routes here)

internal object JSECryptoGlobals {
    private class Err(m: String) : Exception(m)
    private fun fail(m: String): Err = Err(m)

    // ── value plumbing (JSECrypto.data/bytes — the BufferSource coercion — live in Jse.kt) ──
    private fun str(v: Any?): String = JSE.string(v)
    private fun b64url(d: ByteArray): String =
        Base64.getEncoder().encodeToString(d).replace("+", "-").replace("/", "_").replace("=", "")
    private fun b64urlDecode(s: String): ByteArray? {
        var b = s.replace("-", "+").replace("_", "/")
        while (b.length % 4 != 0) b += "="
        return try { Base64.getDecoder().decode(b) } catch (_: Exception) { null }
    }

    /// AlgorithmIdentifier: a bare string ('SHA-256') or a dict ({ name: 'AES-GCM', iv }).
    private fun algName(v: Any?): String {
        (v as? Map<String, Any?>)?.let { return str(it["name"]).uppercase() }
        return str(v).uppercase()
    }
    private fun algDict(v: Any?): Map<String, Any?> = (v as? Map<String, Any?>) ?: mapOf("name" to str(v))
    /// The hash member ('SHA-256' or { name: 'SHA-256' }) of an algorithm dict — or the bare alg.
    private fun hashName(v: Any?): String {
        val d = algDict(v)
        d["hash"]?.let { return algName(it) }
        return algName(v)
    }

    // ── CryptoKey dicts (CryptoKey-shaped; material rides internal fields) ─────────────────
    private fun key(kind: String, type: String, material: ByteArray, algorithm: Map<String, Any?>,
                    extractable: Boolean, usages: List<Any?>, pub: ByteArray? = null): Map<String, Any?> {
        val d = linkedMapOf<String, Any?>("type" to type, "extractable" to extractable,
            "algorithm" to algorithm, "usages" to usages,
            "__kind" to kind, "__k" to Base64.getEncoder().encodeToString(material))
        // JVM divergence seam: EC/OKP public-from-private isn't derivable here (see header)
        if (pub != null) d["__pub"] = Base64.getEncoder().encodeToString(pub)
        return d
    }
    private fun material(k: Any?): ByteArray {
        val d = k as? Map<String, Any?> ?: throw fail("not a CryptoKey")
        val b = d["__k"] as? String ?: throw fail("not a CryptoKey")
        return try { Base64.getDecoder().decode(b) } catch (_: Exception) { throw fail("not a CryptoKey") }
    }
    private fun storedPub(k: Any?): ByteArray? =
        ((k as? Map<String, Any?>)?.get("__pub") as? String)?.let { try { Base64.getDecoder().decode(it) } catch (_: Exception) { null } }
    private fun kind(k: Any?): String = str((k as? Map<String, Any?>)?.get("__kind"))
    private fun keyAlg(k: Any?): Map<String, Any?> =
        ((k as? Map<String, Any?>)?.get("algorithm") as? Map<String, Any?>) ?: emptyMap()

    // ── entry ──────────────────────────────────────────────────────────────────────────────
    fun call(name: String, a: List<Any?>): Any? =
        try { dispatch(name, a) } catch (e: Exception) { kernelLog("[JSE crypto] $name: ${e.message ?: e}"); null }

    private fun dispatch(name: String, a: List<Any?>): Any? {
        fun arg(i: Int): Any? = a.getOrNull(i)
        when (name) {
            // ── companion globals ──
            "Uint8Array" -> {
                val n = JSE.number(arg(0))
                if (n != null && arg(0) !is List<*>) return List<Any?>(maxOf(0, n.toInt())) { 0.0 }
                JSECrypto.data(arg(0))?.let { return JSECrypto.bytes(it) }
                return listOf<Any?>()
            }
            "Uint8Array.fromHex" -> {
                val s = str(arg(0)).replace(" ", "")
                if (s.length % 2 != 0) throw fail("odd hex length")
                val d = ByteArray(s.length / 2)
                for (i in d.indices) {
                    val hi = Character.digit(s[2 * i], 16); val lo = Character.digit(s[2 * i + 1], 16)
                    if (hi < 0 || lo < 0) throw fail("bad hex")
                    d[i] = (hi * 16 + lo).toByte()
                }
                return JSECrypto.bytes(d)
            }
            "Uint8Array.fromBase64" -> {
                val d = (try { Base64.getDecoder().decode(str(arg(0))) } catch (_: Exception) { null })
                    ?: b64urlDecode(str(arg(0))) ?: throw fail("bad base64")
                return JSECrypto.bytes(d)
            }
            "TextEncoder" -> return linkedMapOf<String, Any?>("__textEncoder" to true)
            "TextDecoder" -> return linkedMapOf<String, Any?>("__textDecoder" to true)
            "Array.from" -> return (arg(0) as? List<Any?>) ?: JSECrypto.data(arg(0))?.let { JSECrypto.bytes(it) } ?: listOf<Any?>()
            "btoa" -> {
                val scalars = str(arg(0)).codePoints().toArray()
                val d = ByteArray(scalars.size)
                for (i in scalars.indices) d[i] = (scalars[i] and 0xFF).toByte()   // UInt8(truncatingIfNeeded:)
                return Base64.getEncoder().encodeToString(d)
            }
            "atob" -> {
                val d = try { Base64.getDecoder().decode(str(arg(0))) } catch (_: Exception) { throw fail("bad base64") }
                return String(d, Charsets.ISO_8859_1)              // each byte → the same Unicode scalar
            }

            // ── crypto.* ──
            "crypto.randomUUID" -> return UUID.randomUUID().toString().lowercase()
            "crypto.getRandomValues" -> {
                val count = (arg(0) as? List<Any?>)?.size ?: (JSE.number(arg(0)) ?: 0.0).toInt()
                if (count <= 0 || count > 65536) throw fail("getRandomValues: 1…65536 bytes")
                return JSECrypto.bytes(random(count))
            }

            // ── crypto.subtle.* ──
            "crypto.subtle.digest" -> {
                val d = JSECrypto.data(arg(1)) ?: throw fail("digest: data required")
                return JSECrypto.bytes(digest(hashName(arg(0)), d))
            }
            "crypto.subtle.sign" -> return JSECrypto.bytes(sign(arg(0), arg(1), JSECrypto.data(arg(2)) ?: ByteArray(0)))
            "crypto.subtle.verify" -> return verify(arg(0), arg(1), JSECrypto.data(arg(2)) ?: ByteArray(0), JSECrypto.data(arg(3)) ?: ByteArray(0))
            "crypto.subtle.encrypt" -> return JSECrypto.bytes(encrypt(arg(0), arg(1), JSECrypto.data(arg(2)) ?: ByteArray(0)))
            "crypto.subtle.decrypt" -> return JSECrypto.bytes(decrypt(arg(0), arg(1), JSECrypto.data(arg(2)) ?: ByteArray(0)))
            "crypto.subtle.generateKey" -> return generateKey(arg(0), JSE.truthy(arg(1)), (arg(2) as? List<Any?>) ?: emptyList())
            "crypto.subtle.importKey" -> return importKey(str(arg(0)), arg(1), arg(2), JSE.truthy(arg(3)), (arg(4) as? List<Any?>) ?: emptyList())
            "crypto.subtle.exportKey" -> return exportKey(str(arg(0)), arg(1))
            "crypto.subtle.deriveBits" -> return JSECrypto.bytes(deriveBits(arg(0), arg(1), arg(2)?.let { JSE.number(it) }?.toInt()))
            "crypto.subtle.deriveKey" -> {
                val raw = deriveBits(arg(0), arg(1), derivedKeyLengthBits(arg(2)))
                return importKey("raw", JSECrypto.bytes(raw), arg(2), JSE.truthy(arg(3)), (arg(4) as? List<Any?>) ?: emptyList())
            }
            "crypto.subtle.wrapKey" -> {
                val exported = exportKey(str(arg(0)), arg(1))
                val payload: ByteArray = if (str(arg(0)) == "jwk") jsonString(exported).toByteArray(Charsets.UTF_8)
                else (JSECrypto.data(exported) ?: ByteArray(0))
                if (algName(arg(3)) == "AES-KW") return JSECrypto.bytes(aesKeyWrap(payload, material(arg(2))))
                return JSECrypto.bytes(encrypt(arg(3), arg(2), payload))
            }
            "crypto.subtle.unwrapKey" -> {
                val wrapped = JSECrypto.data(arg(1)) ?: ByteArray(0)
                val raw: ByteArray = if (algName(arg(3)) == "AES-KW") aesKeyUnwrap(wrapped, material(arg(2)))
                else decrypt(arg(3), arg(2), wrapped)
                val keyData: Any? = if (str(arg(0)) == "jwk") {
                    val o = JSECoreGlobals.jsonParse(String(raw, Charsets.UTF_8))
                    if (o === JSECoreGlobals.INVALID_JSON) throw fail("jwk parse") else o
                } else JSECrypto.bytes(raw)
                return importKey(str(arg(0)), keyData, arg(4), JSE.truthy(arg(5)), (arg(6) as? List<Any?>) ?: emptyList())
            }
            else -> throw fail("unsupported: $name")
        }
    }

    private fun jsonString(v: Any?): String =
        JSECoreGlobals.jsonWrite(v, pretty = false, sortKeys = true) ?: throw fail("jwk serialization")
    private fun derivedKeyLengthBits(alg: Any?): Int? {
        val d = algDict(alg)
        d["length"]?.let { JSE.number(it) }?.let { return it.toInt() }
        return when (algName(alg)) {                    // HMAC default key = hash block size
            "HMAC" -> when (hashName(alg)) {
                "SHA-384", "SHA-512" -> 1024
                else -> 512
            }
            else -> 256                                 // AES-* default in deriveKey
        }
    }

    // ── digest ─────────────────────────────────────────────────────────────────────────────
    private fun digest(alg: String, d: ByteArray): ByteArray = when (alg) {
        "SHA-1", "SHA-256", "SHA-384", "SHA-512" -> MessageDigest.getInstance(alg).digest(d)
        else -> throw fail("digest: $alg")
    }

    // ── HMAC ───────────────────────────────────────────────────────────────────────────────
    private fun macInstance(hash: String, key: ByteArray): Mac {
        val alg = when (hash) {
            "SHA-1" -> "HmacSHA1"; "SHA-256" -> "HmacSHA256"; "SHA-384" -> "HmacSHA384"; "SHA-512" -> "HmacSHA512"
            else -> throw fail("HMAC hash: $hash")
        }
        val m = Mac.getInstance(alg)
        // "" and {0x00} pad to the same all-zeros block key — keeps empty keys total (JCE rejects empty)
        m.init(SecretKeySpec(if (key.isEmpty()) ByteArray(1) else key, alg))
        return m
    }
    private fun hmac(hash: String, key: ByteArray, data: ByteArray): ByteArray = macInstance(hash, key).doFinal(data)

    // ── sign / verify ──────────────────────────────────────────────────────────────────────
    private fun sign(alg: Any?, key: Any?, d: ByteArray): ByteArray {
        val m = material(key)
        return when (algName(alg)) {
            "HMAC" -> hmac(hashName(keyAlg(key)), m, d)
            "ECDSA" -> ecdsaSign(str(keyAlg(key)["namedCurve"]), hashName(alg), m, d)
            "ED25519" -> {
                val sig = Signature.getInstance("Ed25519")
                sig.initSign(edPrivate(m)); sig.update(d); sig.sign()
            }
            "RSASSA-PKCS1-V1_5", "RSA-PSS" -> rsaSign(algName(alg), hashName(keyAlg(key)), alg, key, d)
            else -> throw fail("sign: ${algName(alg)}")
        }
    }
    private fun verify(alg: Any?, key: Any?, signature: ByteArray, d: ByteArray): Boolean {
        val m = material(key)
        return when (algName(alg)) {
            "HMAC" -> {
                val mac = hmac(hashName(keyAlg(key)), m, d)
                MessageDigest.isEqual(mac, signature)            // constant-time
            }
            "ECDSA" -> ecdsaVerify(str(keyAlg(key)["namedCurve"]), hashName(alg), m, signature, d)
            "ED25519" -> try {
                val sig = Signature.getInstance("Ed25519")
                sig.initVerify(edPublic(m)); sig.update(d); sig.verify(signature)
            } catch (_: Exception) { false }
            "RSASSA-PKCS1-V1_5", "RSA-PSS" -> rsaVerify(algName(alg), hashName(keyAlg(key)), alg, key, signature, d)
            else -> throw fail("verify: ${algName(alg)}")
        }
    }

    // ── encrypt / decrypt ──────────────────────────────────────────────────────────────────
    private fun encrypt(alg: Any?, key: Any?, d: ByteArray): ByteArray {
        val p = algDict(alg)
        return when (algName(alg)) {
            "AES-GCM" -> {
                p["tagLength"]?.let { JSE.number(it) }?.let { if (it.toInt() != 128) throw fail("AES-GCM tagLength: 128 only") }
                val iv = JSECrypto.data(p["iv"]) ?: throw fail("AES-GCM: iv required")
                val c = Cipher.getInstance("AES/GCM/NoPadding")
                c.init(Cipher.ENCRYPT_MODE, SecretKeySpec(material(key), "AES"), GCMParameterSpec(128, iv))
                JSECrypto.data(p["additionalData"])?.let { c.updateAAD(it) }
                c.doFinal(d)                                     // WebCrypto: ciphertext ‖ tag (Java appends)
            }
            "AES-CBC" -> {
                val iv = JSECrypto.data(p["iv"])
                if (iv == null || iv.size != 16) throw fail("AES-CBC: 16-byte iv required")
                aesCipher("AES/CBC/PKCS5Padding", Cipher.ENCRYPT_MODE, material(key), iv).doFinal(d)
            }
            "AES-CTR" -> {
                val counter = JSECrypto.data(p["counter"])
                if (counter == null || counter.size != 16) throw fail("AES-CTR: 16-byte counter required")
                aesCipher("AES/CTR/NoPadding", Cipher.ENCRYPT_MODE, material(key), counter).doFinal(d)
            }
            "RSA-OAEP" -> {
                if (p["label"] != null) throw fail("RSA-OAEP: label unsupported")
                rsaCrypt(encrypt = true, hash = hashName(keyAlg(key)), k = key, d = d)
            }
            else -> throw fail("encrypt: ${algName(alg)}")
        }
    }
    private fun decrypt(alg: Any?, key: Any?, d: ByteArray): ByteArray {
        val p = algDict(alg)
        return when (algName(alg)) {
            "AES-GCM" -> {
                val iv = JSECrypto.data(p["iv"])
                if (iv == null || d.size < 16) throw fail("AES-GCM: iv/ciphertext")
                val c = Cipher.getInstance("AES/GCM/NoPadding")
                c.init(Cipher.DECRYPT_MODE, SecretKeySpec(material(key), "AES"), GCMParameterSpec(128, iv))
                JSECrypto.data(p["additionalData"])?.let { c.updateAAD(it) }
                c.doFinal(d)
            }
            "AES-CBC" -> {
                val iv = JSECrypto.data(p["iv"])
                if (iv == null || iv.size != 16) throw fail("AES-CBC: 16-byte iv required")
                aesCipher("AES/CBC/PKCS5Padding", Cipher.DECRYPT_MODE, material(key), iv).doFinal(d)
            }
            "AES-CTR" -> {
                val counter = JSECrypto.data(p["counter"])
                if (counter == null || counter.size != 16) throw fail("AES-CTR: 16-byte counter required")
                aesCipher("AES/CTR/NoPadding", Cipher.DECRYPT_MODE, material(key), counter).doFinal(d)
            }
            "RSA-OAEP" -> {
                if (p["label"] != null) throw fail("RSA-OAEP: label unsupported")
                rsaCrypt(encrypt = false, hash = hashName(keyAlg(key)), k = key, d = d)
            }
            else -> throw fail("decrypt: ${algName(alg)}")
        }
    }
    private fun aesCipher(transform: String, mode: Int, key: ByteArray, iv: ByteArray): Cipher {
        val c = Cipher.getInstance(transform)
        c.init(mode, SecretKeySpec(key, "AES"), IvParameterSpec(iv))
        return c
    }
    private fun aesKeyWrap(payload: ByteArray, kek: ByteArray): ByteArray {
        val c = Cipher.getInstance("AESWrap")
        c.init(Cipher.WRAP_MODE, SecretKeySpec(kek, "AES"))
        return c.wrap(SecretKeySpec(payload, "AES"))
    }
    private fun aesKeyUnwrap(wrapped: ByteArray, kek: ByteArray): ByteArray {
        val c = Cipher.getInstance("AESWrap")
        c.init(Cipher.UNWRAP_MODE, SecretKeySpec(kek, "AES"))
        return (c.unwrap(wrapped, "AES", Cipher.SECRET_KEY) as javax.crypto.SecretKey).encoded
    }

    // ── deriveBits: PBKDF2 · HKDF · ECDH · X25519 ─────────────────────────────────────────
    private fun deriveBits(alg: Any?, key: Any?, lengthBits: Int?): ByteArray {
        val p = algDict(alg)
        when (algName(alg)) {
            "PBKDF2" -> {
                val bits = lengthBits ?: throw fail("PBKDF2: length (bits, ×8)")
                if (bits <= 0 || bits % 8 != 0) throw fail("PBKDF2: length (bits, ×8)")
                val salt = JSECrypto.data(p["salt"]) ?: throw fail("PBKDF2: salt required")
                val iterations = (p["iterations"]?.let { JSE.number(it) } ?: 0.0).toInt()
                if (iterations <= 0) throw fail("PBKDF2: iterations required")
                val hash = hashName(p["hash"])
                if (hash !in listOf("SHA-1", "SHA-256", "SHA-384", "SHA-512")) throw fail("PBKDF2 hash")
                return pbkdf2(hash, material(key), salt, iterations, bits / 8)
            }
            "HKDF" -> {
                val bits = lengthBits ?: throw fail("HKDF: length (bits, ×8)")
                if (bits <= 0 || bits % 8 != 0) throw fail("HKDF: length (bits, ×8)")
                val hash = hashName(p["hash"])
                if (hash !in listOf("SHA-1", "SHA-256", "SHA-384", "SHA-512")) throw fail("HKDF hash")
                return hkdf(hash, material(key), JSECrypto.data(p["salt"]) ?: ByteArray(0),
                    JSECrypto.data(p["info"]) ?: ByteArray(0), bits / 8)
            }
            "ECDH" -> {
                val pub = p["public"] ?: throw fail("ECDH: public key required")
                val secret = ecdh(str(keyAlg(key)["namedCurve"]), material(key), material(pub))
                return if (lengthBits != null) secret.copyOf(lengthBits / 8) else secret
            }
            "X25519" -> {
                val pub = p["public"] ?: throw fail("X25519: public key required")
                val ka = KeyAgreement.getInstance("X25519")
                ka.init(xPrivate(material(key)))
                ka.doPhase(xPublic(material(pub)), true)
                val secret = ka.generateSecret()
                return if (lengthBits != null) secret.copyOf(lengthBits / 8) else secret
            }
            else -> throw fail("deriveBits: ${algName(alg)}")
        }
    }
    private fun pbkdf2(hash: String, password: ByteArray, salt: ByteArray, iterations: Int, outLen: Int): ByteArray {
        val mac = macInstance(hash, password)
        val hLen = mac.macLength
        val blocks = (outLen + hLen - 1) / hLen
        val out = ByteArray(blocks * hLen)
        for (b in 1..blocks) {
            mac.reset()
            mac.update(salt)
            mac.update(byteArrayOf((b ushr 24).toByte(), (b ushr 16).toByte(), (b ushr 8).toByte(), b.toByte()))
            var u = mac.doFinal()
            val t = u.copyOf()
            for (iter in 2..iterations) {
                u = mac.doFinal(u)
                for (k in t.indices) t[k] = (t[k].toInt() xor u[k].toInt()).toByte()
            }
            System.arraycopy(t, 0, out, (b - 1) * hLen, hLen)
        }
        return out.copyOf(outLen)
    }
    private fun hkdf(hash: String, ikm: ByteArray, salt: ByteArray, info: ByteArray, outLen: Int): ByteArray {
        val prk = macInstance(hash, salt).doFinal(ikm)             // extract ("" key == zeros key)
        val mac = macInstance(hash, prk)
        val out = java.io.ByteArrayOutputStream()
        var t = ByteArray(0)
        var i = 1
        while (out.size() < outLen) {
            mac.reset(); mac.update(t); mac.update(info); mac.update(i.toByte())
            t = mac.doFinal()
            out.write(t)
            i += 1
        }
        return out.toByteArray().copyOf(outLen)
    }

    // ── generateKey ────────────────────────────────────────────────────────────────────────
    private fun generateKey(alg: Any?, extractable: Boolean, usages: List<Any?>): Any? {
        val p = algDict(alg)
        when (algName(alg)) {
            "AES-GCM", "AES-CBC", "AES-CTR", "AES-KW" -> {
                val bits = (p["length"]?.let { JSE.number(it) } ?: 256.0).toInt()
                if (bits !in listOf(128, 192, 256)) throw fail("AES length: 128/192/256")
                return key("aes", "secret", random(bits / 8),
                    linkedMapOf<String, Any?>("name" to algName(alg), "length" to bits.toDouble()),
                    extractable, usages)
            }
            "HMAC" -> {
                val hash = hashName(alg)
                val defBytes = if (hash == "SHA-384" || hash == "SHA-512") 128 else 64   // hash block size
                val bits = (p["length"]?.let { JSE.number(it) } ?: (defBytes * 8).toDouble()).toInt()
                return key("hmac", "secret", random(bits / 8),
                    linkedMapOf<String, Any?>("name" to "HMAC", "hash" to linkedMapOf<String, Any?>("name" to hash), "length" to bits.toDouble()),
                    extractable, usages)
            }
            "ECDSA", "ECDH" -> return ecGenerate(algName(alg), str(p["namedCurve"]), extractable, usages)
            "ED25519" -> {
                val pair = KeyPairGenerator.getInstance("Ed25519").generateKeyPair()
                val pubRaw = edPointRaw((pair.public as EdECPublicKey).point)
                val privRaw = (pair.private as EdECPrivateKey).bytes.orElseThrow { fail("Ed25519 seed") }
                val algorithm = linkedMapOf<String, Any?>("name" to "Ed25519")
                return linkedMapOf<String, Any?>(
                    "publicKey" to key("ed25519", "public", pubRaw, algorithm, true, usages),
                    "privateKey" to key("ed25519", "private", privRaw, algorithm, extractable, usages, pub = pubRaw))
            }
            "X25519" -> {
                val pair = KeyPairGenerator.getInstance("X25519").generateKeyPair()
                val pubRaw = xURaw((pair.public as XECPublicKey).u)
                val privRaw = (pair.private as XECPrivateKey).scalar.orElseThrow { fail("X25519 scalar") }
                val algorithm = linkedMapOf<String, Any?>("name" to "X25519")
                return linkedMapOf<String, Any?>(
                    "publicKey" to key("x25519", "public", pubRaw, algorithm, true, usages),
                    "privateKey" to key("x25519", "private", privRaw, algorithm, extractable, usages, pub = pubRaw))
            }
            "RSASSA-PKCS1-V1_5", "RSA-PSS", "RSA-OAEP" -> return rsaGenerate(algName(alg), p, extractable, usages)
            else -> throw fail("generateKey: ${algName(alg)}")
        }
    }
    private fun random(n: Int): ByteArray {
        val d = ByteArray(n)
        SecureRandom().nextBytes(d)
        return d
    }

    // ── importKey / exportKey ──────────────────────────────────────────────────────────────
    private fun importKey(format: String, keyData: Any?, alg: Any?, extractable: Boolean, usages: List<Any?>): Any? {
        val p = algDict(alg)
        val name = algName(alg)
        when (name) {
            "AES-GCM", "AES-CBC", "AES-CTR", "AES-KW", "PBKDF2", "HKDF", "HMAC" -> {
                val raw: ByteArray = when (format) {
                    "raw" -> JSECrypto.data(keyData) ?: throw fail("raw key data")
                    "jwk" -> {
                        val j = keyData as? Map<String, Any?> ?: throw fail("jwk oct")
                        if (str(j["kty"]) != "oct") throw fail("jwk oct")
                        b64urlDecode(str(j["k"])) ?: throw fail("jwk oct")
                    }
                    else -> throw fail("$name: raw/jwk only")
                }
                val algorithm = linkedMapOf<String, Any?>("name" to name)
                if (name == "HMAC") { algorithm["hash"] = linkedMapOf<String, Any?>("name" to hashName(alg)); algorithm["length"] = (raw.size * 8).toDouble() }
                if (name.startsWith("AES")) algorithm["length"] = (raw.size * 8).toDouble()
                val kindName = if (name == "HMAC") "hmac" else if (name.startsWith("AES")) "aes" else "kdf"
                return key(kindName, "secret", raw, algorithm, extractable, usages)
            }
            "ECDSA", "ECDH" -> return ecImport(format, keyData, name, str(p["namedCurve"]), extractable, usages)
            "ED25519", "X25519" -> return okpImport(format, keyData, if (name == "ED25519") "Ed25519" else "X25519", extractable, usages)
            "RSASSA-PKCS1-V1_5", "RSA-PSS", "RSA-OAEP" -> return rsaImport(format, keyData, alg, extractable, usages)
            else -> throw fail("importKey: $name")
        }
    }
    private fun exportKey(format: String, k: Any?): Any? {
        val dict = k as? Map<String, Any?> ?: throw fail("not a CryptoKey")
        val extractable = (dict["extractable"] as? Boolean) ?: JSE.truthy(dict["extractable"])
        if (!extractable) throw fail("key not extractable")
        val m = material(k)
        return when (kind(k)) {
            "aes", "hmac", "kdf" -> when (format) {
                "raw" -> JSECrypto.bytes(m)
                "jwk" -> linkedMapOf<String, Any?>("kty" to "oct", "k" to b64url(m), "ext" to true)
                else -> throw fail("exportKey: raw/jwk")
            }
            "ec-pub", "ec-priv" -> ecExport(format, k, m)
            "ed25519", "x25519" -> okpExport(format, k, m)
            "rsa-pub", "rsa-priv" -> rsaExport(format, k, m)
            else -> throw fail("exportKey: ${kind(k)}")
        }
    }

    // ── EC (P-256 / P-384 / P-521) ────────────────────────────────────────────────────────
    private fun jvmCurve(curve: String): String = when (curve) {
        "P-256" -> "secp256r1"; "P-384" -> "secp384r1"; "P-521" -> "secp521r1"
        else -> throw fail("namedCurve: $curve")
    }
    private fun coordSize(curve: String): Int = when (curve) {
        "P-256" -> 32; "P-384" -> 48; "P-521" -> 66
        else -> throw fail("namedCurve: $curve")
    }
    private fun ecParams(curve: String): ECParameterSpec {
        val ap = AlgorithmParameters.getInstance("EC")
        ap.init(ECGenParameterSpec(jvmCurve(curve)))
        return ap.getParameterSpec(ECParameterSpec::class.java)
    }
    private fun fixed(i: BigInteger, size: Int): ByteArray {
        val raw = i.toByteArray()
        val out = ByteArray(size)
        val src = if (raw.size > size) raw.copyOfRange(raw.size - size, raw.size) else raw
        System.arraycopy(src, 0, out, size - src.size, src.size)
        return out
    }
    /// Raw scalar → java EC private key. Validates size + range like CryptoKit's raw init.
    private fun ecPrivateKey(curve: String, raw: ByteArray): java.security.PrivateKey {
        val params = ecParams(curve)
        val s = BigInteger(1, raw)
        if (raw.size != coordSize(curve) || s.signum() <= 0 || s >= params.order) throw fail("EC private key")
        return KeyFactory.getInstance("EC").generatePrivate(ECPrivateKeySpec(s, params))
    }
    /// X9.63 uncompressed 04‖X‖Y → java EC public key. Validates on-curve like CryptoKit.
    private fun ecPublicKey(curve: String, x963: ByteArray): java.security.PublicKey {
        val size = coordSize(curve)
        if (x963.size != 1 + 2 * size || x963[0] != 0x04.toByte()) throw fail("EC public key")
        val x = BigInteger(1, x963.copyOfRange(1, 1 + size))
        val y = BigInteger(1, x963.copyOfRange(1 + size, 1 + 2 * size))
        val params = ecParams(curve)
        val field = params.curve.field as? java.security.spec.ECFieldFp ?: throw fail("EC field")
        val prime = field.p
        val lhs = y.modPow(BigInteger.TWO, prime)
        val rhs = x.modPow(BigInteger.valueOf(3), prime).add(params.curve.a.multiply(x)).add(params.curve.b).mod(prime)
        if (lhs != rhs) throw fail("EC public key: not on curve")
        return KeyFactory.getInstance("EC").generatePublic(ECPublicKeySpec(ECPoint(x, y), params))
    }
    private fun ecGenerate(name: String, curve: String, extractable: Boolean, usages: List<Any?>): Any? {
        val g = KeyPairGenerator.getInstance("EC")
        g.initialize(ECGenParameterSpec(jvmCurve(curve)))
        val pair = g.generateKeyPair()
        val size = coordSize(curve)
        val pub = pair.public as ECPublicKey
        val pubX963 = byteArrayOf(4) + fixed(pub.w.affineX, size) + fixed(pub.w.affineY, size)
        val privRaw = fixed((pair.private as ECPrivateKey).s, size)
        val algorithm = linkedMapOf<String, Any?>("name" to (if (name == "ECDSA") "ECDSA" else "ECDH"), "namedCurve" to curve)
        return linkedMapOf<String, Any?>(
            "publicKey" to key("ec-pub", "public", pubX963, algorithm, true, usages),
            "privateKey" to key("ec-priv", "private", privRaw, algorithm, extractable, usages, pub = pubX963))
    }
    private fun ecImport(format: String, keyData: Any?, name: String, curve: String,
                         extractable: Boolean, usages: List<Any?>): Any? {
        val algorithm = linkedMapOf<String, Any?>("name" to (if (name == "ECDSA") "ECDSA" else "ECDH"), "namedCurve" to curve)
        fun pub(m: ByteArray) = key("ec-pub", "public", m, algorithm, extractable, usages)
        fun priv(m: ByteArray, p: ByteArray? = null) = key("ec-priv", "private", m, algorithm, extractable, usages, pub = p)
        when (format) {
            "raw" -> {
                val d = JSECrypto.data(keyData) ?: throw fail("raw")
                ecPublicKey(curve, d)                            // validate
                return pub(d)
            }
            "jwk" -> {
                val j = keyData as? Map<String, Any?> ?: throw fail("jwk EC")
                if (str(j["kty"]) != "EC") throw fail("jwk EC")
                if (j["d"] != null) {
                    val dd = b64urlDecode(str(j["d"])) ?: throw fail("jwk d")
                    ecPrivateKey(curve, dd)                      // validate
                    // stash the public half when the jwk carries it (JVM can't derive — header)
                    val x = j["x"]?.let { b64urlDecode(str(it)) }
                    val y = j["y"]?.let { b64urlDecode(str(it)) }
                    val stashed = if (x != null && y != null) byteArrayOf(4) + x + y else null
                    return priv(dd, stashed)
                }
                val x = b64urlDecode(str(j["x"])) ?: throw fail("jwk x/y")
                val y = b64urlDecode(str(j["y"])) ?: throw fail("jwk x/y")
                val m = byteArrayOf(4) + x + y
                ecPublicKey(curve, m)
                return pub(m)
            }
            "spki" -> {
                val d = JSECrypto.data(keyData) ?: throw fail("spki")
                val k = KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(d)) as ECPublicKey
                if (k.params.order != ecParams(curve).order) throw fail("namedCurve")
                val size = coordSize(curve)
                return pub(byteArrayOf(4) + fixed(k.w.affineX, size) + fixed(k.w.affineY, size))
            }
            "pkcs8" -> {
                val d = JSECrypto.data(keyData) ?: throw fail("pkcs8")
                val k = KeyFactory.getInstance("EC").generatePrivate(PKCS8EncodedKeySpec(d)) as ECPrivateKey
                if (k.params.order != ecParams(curve).order) throw fail("namedCurve")
                return priv(fixed(k.s, coordSize(curve)))
            }
            else -> throw fail("ecImport: $format")
        }
    }
    private fun ecExport(format: String, k: Any?, m: ByteArray): Any? {
        val curve = str(keyAlg(k)["namedCurve"])
        val isPriv = kind(k) == "ec-priv"
        when (format) {
            "raw" -> {
                if (isPriv) throw fail("raw export: public keys only")
                return JSECrypto.bytes(m)
            }
            "jwk" -> {
                val half = coordSize(curve)
                if (isPriv) {
                    val pubX963 = storedPub(k)
                        ?: throw fail("jwk export: public half unavailable (imported without it; JVM cannot derive)")
                    val coords = pubX963.copyOfRange(1, pubX963.size)
                    return linkedMapOf<String, Any?>("kty" to "EC", "crv" to curve,
                        "x" to b64url(coords.copyOfRange(0, half)), "y" to b64url(coords.copyOfRange(half, coords.size)),
                        "d" to b64url(m), "ext" to true)
                }
                val coords = m.copyOfRange(1, m.size)            // strip 0x04
                return linkedMapOf<String, Any?>("kty" to "EC", "crv" to curve,
                    "x" to b64url(coords.copyOfRange(0, half)), "y" to b64url(coords.copyOfRange(half, coords.size)),
                    "ext" to true)
            }
            "spki" -> {
                if (isPriv) throw fail("spki: public keys only")
                return JSECrypto.bytes(ecPublicKey(curve, m).encoded)
            }
            "pkcs8" -> {
                if (!isPriv) throw fail("pkcs8: private keys only")
                return JSECrypto.bytes(ecPrivateKey(curve, m).encoded)
            }
            else -> throw fail("ecExport: $format")
        }
    }
    private fun ecdsaAlg(hash: String): String = when (hash) {
        "SHA-256" -> "SHA256withECDSAinP1363Format"              // WebCrypto raw r‖s — never DER
        "SHA-384" -> "SHA384withECDSAinP1363Format"
        "SHA-512" -> "SHA512withECDSAinP1363Format"
        "SHA-1" -> "SHA1withECDSAinP1363Format"
        else -> throw fail("ECDSA hash: $hash")
    }
    private fun ecdsaSign(curve: String, hash: String, priv: ByteArray, d: ByteArray): ByteArray {
        val sig = Signature.getInstance(ecdsaAlg(hash))
        sig.initSign(ecPrivateKey(curve, priv))
        sig.update(d)
        return sig.sign()
    }
    private fun ecdsaVerify(curve: String, hash: String, pub: ByteArray, signature: ByteArray, d: ByteArray): Boolean =
        try {
            val sig = Signature.getInstance(ecdsaAlg(hash))
            sig.initVerify(ecPublicKey(curve, pub))
            sig.update(d)
            sig.verify(signature)
        } catch (e: Err) { throw e } catch (_: Exception) { false }   // malformed sig → false (Swift `try?`)
    private fun ecdh(curve: String, priv: ByteArray, pub: ByteArray): ByteArray {
        val ka = KeyAgreement.getInstance("ECDH")
        ka.init(ecPrivateKey(curve, priv))
        ka.doPhase(ecPublicKey(curve, pub), true)
        return ka.generateSecret()                               // x-coordinate, curve-size (CryptoKit's layout)
    }

    // ── OKP (Ed25519 / X25519) ────────────────────────────────────────────────────────────
    private fun edPrivate(raw: ByteArray): java.security.PrivateKey =
        KeyFactory.getInstance("Ed25519").generatePrivate(EdECPrivateKeySpec(NamedParameterSpec.ED25519, raw))
    private fun edPublic(raw: ByteArray): java.security.PublicKey {
        if (raw.size != 32) throw fail("Ed25519 public: 32 bytes")
        val xOdd = (raw[31].toInt() and 0x80) != 0
        val le = raw.copyOf(); le[31] = (le[31].toInt() and 0x7F).toByte()
        val y = BigInteger(1, le.reversedArray())
        return KeyFactory.getInstance("Ed25519").generatePublic(EdECPublicKeySpec(NamedParameterSpec.ED25519, EdECPoint(xOdd, y)))
    }
    private fun edPointRaw(p: EdECPoint): ByteArray {
        val le = p.y.toByteArray().reversedArray()               // BE → LE
        val out = ByteArray(32)
        System.arraycopy(le, 0, out, 0, minOf(32, le.size))
        if (p.isXOdd) out[31] = (out[31].toInt() or 0x80).toByte()
        return out
    }
    private fun xPrivate(raw: ByteArray): java.security.PrivateKey =
        KeyFactory.getInstance("XDH").generatePrivate(XECPrivateKeySpec(NamedParameterSpec.X25519, raw))
    private fun xPublic(raw: ByteArray): java.security.PublicKey {
        if (raw.size != 32) throw fail("X25519 public: 32 bytes")
        val le = raw.copyOf(); le[31] = (le[31].toInt() and 0x7F).toByte()   // RFC 7748: mask high bit
        val u = BigInteger(1, le.reversedArray())
        return KeyFactory.getInstance("XDH").generatePublic(XECPublicKeySpec(NamedParameterSpec.X25519, u))
    }
    private fun xURaw(u: BigInteger): ByteArray {
        val le = u.toByteArray().reversedArray()
        val out = ByteArray(32)
        System.arraycopy(le, 0, out, 0, minOf(32, le.size))
        return out
    }
    private fun okpImport(format: String, keyData: Any?, name: String,
                          extractable: Boolean, usages: List<Any?>): Any? {
        val kindName = if (name == "Ed25519") "ed25519" else "x25519"
        val algorithm = linkedMapOf<String, Any?>("name" to name)
        when (format) {
            "raw" -> {
                val d = JSECrypto.data(keyData)
                if (d == null || d.size != 32) throw fail("raw: 32 bytes")
                return key(kindName, "public", d, algorithm, extractable, usages)
            }
            "jwk" -> {
                val j = keyData as? Map<String, Any?> ?: throw fail("jwk OKP")
                if (str(j["kty"]) != "OKP") throw fail("jwk OKP")
                val dPart = j["d"]?.let { b64urlDecode(str(it)) }
                if (dPart != null) {
                    val x = j["x"]?.let { b64urlDecode(str(it)) }   // stash pub if the jwk carries it
                    return key(kindName, "private", dPart, algorithm, extractable, usages, pub = x)
                }
                val x = b64urlDecode(str(j["x"])) ?: throw fail("jwk x")
                return key(kindName, "public", x, algorithm, extractable, usages)
            }
            else -> throw fail("okpImport: raw/jwk")
        }
    }
    private fun okpExport(format: String, k: Any?, m: ByteArray): Any? {
        val isPriv = str((k as? Map<String, Any?>)?.get("type")) == "private"
        val name = str(keyAlg(k)["name"])
        when (format) {
            "raw" -> {
                if (isPriv) throw fail("raw export: public keys only")
                return JSECrypto.bytes(m)
            }
            "jwk" -> {
                if (isPriv) {
                    val pub = storedPub(k)
                        ?: throw fail("jwk export: public half unavailable (imported without it; JVM cannot derive)")
                    return linkedMapOf<String, Any?>("kty" to "OKP", "crv" to name, "x" to b64url(pub), "d" to b64url(m), "ext" to true)
                }
                return linkedMapOf<String, Any?>("kty" to "OKP", "crv" to name, "x" to b64url(m), "ext" to true)
            }
            else -> throw fail("okpExport: raw/jwk")
        }
    }

    // ── RSA — RSASSA-PKCS1-v1_5 · RSA-PSS · RSA-OAEP (material = PKCS#1, like SecKey) ──────
    private fun rsaGenerate(name: String, p: Map<String, Any?>, extractable: Boolean, usages: List<Any?>): Any? {
        (p["publicExponent"] as? List<Any?>)?.let { e ->
            val bytesE = e.mapNotNull { JSE.number(it)?.toLong()?.toByte() }
            if (bytesE != listOf<Byte>(1, 0, 1)) throw fail("publicExponent: 65537 only")
        }
        val bits = (p["modulusLength"]?.let { JSE.number(it) } ?: 2048.0).toInt()
        val g = KeyPairGenerator.getInstance("RSA")
        g.initialize(RSAKeyGenParameterSpec(bits, RSAKeyGenParameterSpec.F4))
        val pair = g.generateKeyPair()
        val privPKCS1 = derUnwrapPKCS8(pair.private.encoded)
        val pubPKCS1 = derUnwrapSPKI(pair.public.encoded)
        val algorithm = linkedMapOf<String, Any?>("name" to rsaPretty(name), "modulusLength" to bits.toDouble(),
            "publicExponent" to listOf<Any?>(1.0, 0.0, 1.0),
            "hash" to linkedMapOf<String, Any?>("name" to hashName(p["hash"] ?: "SHA-256")))
        return linkedMapOf<String, Any?>(
            "publicKey" to key("rsa-pub", "public", pubPKCS1, algorithm, true, usages),
            "privateKey" to key("rsa-priv", "private", privPKCS1, algorithm, extractable, usages))
    }
    private fun rsaPretty(upper: String): String = when (upper) {
        "RSASSA-PKCS1-V1_5" -> "RSASSA-PKCS1-v1_5"
        else -> upper                                            // RSA-PSS / RSA-OAEP are already canonical
    }
    private fun rsaImport(format: String, keyData: Any?, alg: Any?, extractable: Boolean, usages: List<Any?>): Any? {
        val name = rsaPretty(algName(alg))
        val algorithm = linkedMapOf<String, Any?>("name" to name, "hash" to linkedMapOf<String, Any?>("name" to hashName(alg)))
        when (format) {
            "spki" -> {
                val d = JSECrypto.data(keyData) ?: throw fail("spki data")
                val pkcs1 = derUnwrapSPKI(d)
                rsaKey(pkcs1, isPrivate = false)                 // validate
                return key("rsa-pub", "public", pkcs1, algorithm, extractable, usages)
            }
            "pkcs8" -> {
                val d = JSECrypto.data(keyData) ?: throw fail("pkcs8 data")
                val pkcs1 = derUnwrapPKCS8(d)
                rsaKey(pkcs1, isPrivate = true)
                return key("rsa-priv", "private", pkcs1, algorithm, extractable, usages)
            }
            "jwk" -> {
                val j = keyData as? Map<String, Any?> ?: throw fail("jwk RSA")
                if (str(j["kty"]) != "RSA") throw fail("jwk RSA")
                val n = b64urlDecode(str(j["n"])) ?: throw fail("jwk RSA")
                val e = b64urlDecode(str(j["e"])) ?: throw fail("jwk RSA")
                if (j["d"] != null) {
                    val parts = listOf("n", "e", "d", "p", "q", "dp", "dq", "qi").map { b64urlDecode(str(j[it])) }
                    if (parts.any { it == null }) throw fail("jwk RSA private: full CRT set required")
                    val ints = listOf(byteArrayOf(0)) + parts.map { it!! }   // version 0 ‖ n e d p q dp dq qi
                    val pkcs1 = derSequence(ints.map { derInteger(it) }.fold(ByteArray(0)) { acc, b -> acc + b })
                    rsaKey(pkcs1, isPrivate = true)
                    return key("rsa-priv", "private", pkcs1, algorithm, extractable, usages)
                }
                val pkcs1 = derSequence(derInteger(n) + derInteger(e))
                rsaKey(pkcs1, isPrivate = false)
                return key("rsa-pub", "public", pkcs1, algorithm, extractable, usages)
            }
            else -> throw fail("rsaImport: spki/pkcs8/jwk")
        }
    }
    private fun rsaExport(format: String, k: Any?, pkcs1: ByteArray): Any? {
        val isPriv = kind(k) == "rsa-priv"
        when (format) {
            "spki" -> {
                if (isPriv) throw fail("spki: public keys only")
                return JSECrypto.bytes(derWrapSPKI(pkcs1))
            }
            "pkcs8" -> {
                if (!isPriv) throw fail("pkcs8: private keys only")
                return JSECrypto.bytes(derWrapPKCS8(pkcs1))
            }
            "jwk" -> {
                val ints = derReadIntegers(pkcs1).toMutableList()
                if (isPriv) {
                    if (ints.size < 9) throw fail("pkcs1 private shape")
                    ints.removeAt(0)                             // version
                    val names = listOf("n", "e", "d", "p", "q", "dp", "dq", "qi")
                    val j = linkedMapOf<String, Any?>("kty" to "RSA", "ext" to true)
                    for ((i, nm) in names.withIndex()) j[nm] = b64url(ints[i])
                    return j
                }
                if (ints.size < 2) throw fail("pkcs1 public shape")
                return linkedMapOf<String, Any?>("kty" to "RSA", "n" to b64url(ints[0]), "e" to b64url(ints[1]), "ext" to true)
            }
            else -> throw fail("rsaExport: spki/pkcs8/jwk")
        }
    }
    private fun rsaKey(pkcs1: ByteArray, isPrivate: Boolean): java.security.Key = try {
        val kf = KeyFactory.getInstance("RSA")
        if (isPrivate) kf.generatePrivate(PKCS8EncodedKeySpec(derWrapPKCS8(pkcs1)))
        else kf.generatePublic(X509EncodedKeySpec(derWrapSPKI(pkcs1)))
    } catch (_: Exception) { throw fail("RSA key: invalid PKCS#1") }
    private fun jvmHash(hash: String): String = when (hash) {
        "SHA-1" -> "SHA-1"; "SHA-256" -> "SHA-256"; "SHA-384" -> "SHA-384"; "SHA-512" -> "SHA-512"
        else -> throw fail("RSA hash: $hash")
    }
    private fun mgf1Spec(hash: String): MGF1ParameterSpec = when (hash) {
        "SHA-1" -> MGF1ParameterSpec.SHA1; "SHA-256" -> MGF1ParameterSpec.SHA256
        "SHA-384" -> MGF1ParameterSpec.SHA384; "SHA-512" -> MGF1ParameterSpec.SHA512
        else -> throw fail("RSA hash: $hash")
    }
    private fun hashByteLength(hash: String): Int = when (hash) {
        "SHA-1" -> 20; "SHA-384" -> 48; "SHA-512" -> 64; else -> 32
    }
    private fun rsaSignature(name: String, hash: String): Signature {
        return when (name) {
            "RSASSA-PKCS1-V1_5" -> Signature.getInstance(when (hash) {
                "SHA-1" -> "SHA1withRSA"; "SHA-256" -> "SHA256withRSA"
                "SHA-384" -> "SHA384withRSA"; "SHA-512" -> "SHA512withRSA"
                else -> throw fail("RSA: $name+$hash")
            })
            "RSA-PSS" -> {
                val s = Signature.getInstance("RSASSA-PSS")
                // PSS salt length = hash length (the SecKey contract — pinned, Java defaults differ)
                s.setParameter(PSSParameterSpec(jvmHash(hash), "MGF1", mgf1Spec(hash), hashByteLength(hash), 1))
                s
            }
            else -> throw fail("RSA: $name+$hash")
        }
    }
    private fun pssSaltCheck(name: String, hash: String, alg: Any?) {
        if (name != "RSA-PSS") return
        val s = algDict(alg)["saltLength"]?.let { JSE.number(it) } ?: return
        if (s.toInt() != hashByteLength(hash)) throw fail("RSA-PSS saltLength: must equal hash length (SecKey)")
    }
    private fun rsaSign(name: String, hash: String, alg: Any?, k: Any?, d: ByteArray): ByteArray {
        pssSaltCheck(name, hash, alg)
        val sig = rsaSignature(name, hash)
        sig.initSign(rsaKey(material(k), isPrivate = true) as java.security.PrivateKey)
        sig.update(d)
        return sig.sign()
    }
    private fun rsaVerify(name: String, hash: String, alg: Any?, k: Any?, signature: ByteArray, d: ByteArray): Boolean {
        pssSaltCheck(name, hash, alg)
        return try {
            val sig = rsaSignature(name, hash)
            sig.initVerify(rsaKey(material(k), isPrivate = false) as java.security.PublicKey)
            sig.update(d)
            sig.verify(signature)
        } catch (e: Err) { throw e } catch (_: Exception) { false }
    }
    private fun rsaCrypt(encrypt: Boolean, hash: String, k: Any?, d: ByteArray): ByteArray {
        val c = Cipher.getInstance("RSA/ECB/OAEPPadding")
        val spec = OAEPParameterSpec(jvmHash(hash), "MGF1", mgf1Spec(hash), PSource.PSpecified.DEFAULT)
        val rk = rsaKey(material(k), isPrivate = !encrypt)
        c.init(if (encrypt) Cipher.ENCRYPT_MODE else Cipher.DECRYPT_MODE, rk, spec)
        return c.doFinal(d)
    }

    // ── minimal DER (just enough for RSA SPKI/PKCS#8 ↔ PKCS#1 and JWK ints) ───────────────
    private val rsaOIDAlgId = byteArrayOf(0x30, 0x0D, 0x06, 0x09, 0x2A, 0x86.toByte(), 0x48, 0x86.toByte(),
        0xF7.toByte(), 0x0D, 0x01, 0x01, 0x01, 0x05, 0x00)      // SEQ{ OID rsaEncryption, NULL }
    private fun derLength(n: Int): ByteArray {
        if (n < 0x80) return byteArrayOf(n.toByte())
        var v = n
        var out = ByteArray(0)
        while (v > 0) { out = byteArrayOf((v and 0xFF).toByte()) + out; v = v ushr 8 }
        return byteArrayOf((0x80 or out.size).toByte()) + out
    }
    private fun derTag(tag: Int, content: ByteArray): ByteArray = byteArrayOf(tag.toByte()) + derLength(content.size) + content
    private fun derSequence(content: ByteArray): ByteArray = derTag(0x30, content)
    private fun derInteger(raw: ByteArray): ByteArray {
        var v = raw
        while (v.size > 1 && v[0] == 0.toByte()) v = v.copyOfRange(1, v.size)            // minimal form
        if (v.isNotEmpty() && (v[0].toInt() and 0x80) != 0) v = byteArrayOf(0) + v       // keep positive
        return derTag(0x02, v)
    }
    private fun derWrapSPKI(pkcs1: ByteArray): ByteArray =
        derSequence(rsaOIDAlgId + derTag(0x03, byteArrayOf(0) + pkcs1))                  // BIT STRING, 0 unused bits
    private fun derWrapPKCS8(pkcs1: ByteArray): ByteArray =
        derSequence(derInteger(byteArrayOf(0)) + rsaOIDAlgId + derTag(0x04, pkcs1))
    /// One TLV step: (tag, content start, content length, next index).
    private class DerStep(val tag: Int, val start: Int, val len: Int, val next: Int)
    private fun derStep(d: ByteArray, i: Int): DerStep {
        if (i + 1 >= d.size) throw fail("der: truncated")
        val tag = d[i].toInt() and 0xFF
        var p = i + 1
        var len = d[p].toInt() and 0xFF; p += 1
        if (len and 0x80 != 0) {
            val n = len and 0x7F
            if (n <= 0 || n > 4 || p + n > d.size) throw fail("der: length")
            len = 0
            for (q in 0 until n) { len = (len shl 8) or (d[p].toInt() and 0xFF); p += 1 }
        }
        if (p + len > d.size) throw fail("der: overrun")
        return DerStep(tag, p, len, p + len)
    }
    private fun derUnwrapSPKI(d: ByteArray): ByteArray {
        val outer = derStep(d, 0)
        if (outer.tag != 0x30) throw fail("spki: SEQUENCE")
        val algId = derStep(d, outer.start)                      // AlgorithmIdentifier (skip)
        val bits = derStep(d, algId.next)
        if (bits.tag != 0x03 || bits.len <= 1) throw fail("spki: BIT STRING")
        return d.copyOfRange(bits.start + 1, bits.start + bits.len)
    }
    private fun derUnwrapPKCS8(d: ByteArray): ByteArray {
        val outer = derStep(d, 0)
        if (outer.tag != 0x30) throw fail("pkcs8: SEQUENCE")
        val version = derStep(d, outer.start)                    // INTEGER 0
        val algId = derStep(d, version.next)                     // AlgorithmIdentifier (skip)
        val octets = derStep(d, algId.next)
        if (octets.tag != 0x04) throw fail("pkcs8: OCTET STRING")
        return d.copyOfRange(octets.start, octets.start + octets.len)
    }
    /// All INTEGERs of a PKCS#1 SEQUENCE, leading zero stripped (for JWK b64url parts).
    private fun derReadIntegers(d: ByteArray): List<ByteArray> {
        val outer = derStep(d, 0)
        if (outer.tag != 0x30) throw fail("pkcs1: SEQUENCE")
        val out = ArrayList<ByteArray>()
        var i = outer.start
        while (i < outer.start + outer.len) {
            val t = derStep(d, i)
            if (t.tag != 0x02) break
            var v = d.copyOfRange(t.start, t.start + t.len)
            while (v.size > 1 && v[0] == 0.toByte()) v = v.copyOfRange(1, v.size)
            out.add(v)
            i = t.next
        }
        return out
    }
}
