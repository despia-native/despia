//
//  Payment.kt — the Kotlin twin of Engine/iOS/Payment.swift and the web kernel's payment.ts:
//  the SHARED PURE CORE behind Core/Pay (F17.2).
//
//  THE MONEY IS THE WHOLE POINT. Apple Pay, Google Pay and the Payment Request API take three
//  differently-shaped requests and each hides a bad one differently: one shows a wrong number,
//  one throws, one silently drops a row. So the arithmetic, the currency exponents, the network
//  vocabulary and the SUM CHECK live here and are pinned by
//  OpenSource/Conformance/pay/request.json. The platform sheets are plumbing.
//
//  BINARY FLOATS ARE REFUSED FOR FRACTIONAL AMOUNTS. An amount is a DECIMAL STRING in the
//  currency's major unit ("12.34"), or a JSON number only when it is a whole integer. A
//  fractional Double is refused with a message that says to quote it, because a checkout that
//  is off by a cent for one customer in a thousand is unfixable after the fact.
//
//  Pure JVM — no Android imports, so it runs in :core's SDK-free test lane.
//
package despia.engine

object Payment {

    /** A payment larger than this is a data-entry error, not a purchase. In minor units. */
    const val MAX_MINOR = 1_000_000_000_000L

    /** Currencies whose minor unit is not 1/100. Absent means exponent 2, the ISO default. */
    private val CURRENCY_EXPONENTS: Map<String, Int> = mapOf(
        "BIF" to 0, "CLP" to 0, "DJF" to 0, "GNF" to 0, "ISK" to 0, "JPY" to 0, "KMF" to 0,
        "KRW" to 0, "PYG" to 0, "RWF" to 0, "UGX" to 0, "UYI" to 0, "VND" to 0, "VUV" to 0,
        "XAF" to 0, "XOF" to 0, "XPF" to 0,
        "BHD" to 3, "IQD" to 3, "JOD" to 3, "KWD" to 3, "LYD" to 3, "OMR" to 3, "TND" to 3,
    )

    val NETWORKS: List<String> = listOf(
        "amex", "cartesBancaires", "discover", "eftpos", "electron", "elo", "girocard",
        "interac", "jcb", "maestro", "mada", "mastercard", "unionPay", "visa",
    )

    private val NETWORK_ALIASES: Map<String, String> = mapOf(
        "amex" to "amex", "americanexpress" to "amex",
        "cartesbancaires" to "cartesBancaires", "cb" to "cartesBancaires",
        "discover" to "discover",
        "eftpos" to "eftpos", "eftposaustralia" to "eftpos",
        "electron" to "electron", "visaelectron" to "electron",
        "elo" to "elo",
        "girocard" to "girocard",
        "interac" to "interac",
        "jcb" to "jcb",
        "maestro" to "maestro",
        "mada" to "mada",
        "mastercard" to "mastercard", "master" to "mastercard",
        "unionpay" to "unionPay", "chinaunionpay" to "unionPay",
        "visa" to "visa",
    )

    val CAPABILITIES: List<String> = listOf("threeDS", "debit", "credit", "emv")

    private val CAPABILITY_ALIASES: Map<String, String> = mapOf(
        "3ds" to "threeDS", "threeds" to "threeDS", "3dsecure" to "threeDS",
        "debit" to "debit", "credit" to "credit", "emv" to "emv",
    )

    val FIELDS: List<String> = listOf("name", "email", "phone", "postalAddress")

    private val FIELD_ALIASES: Map<String, String> = mapOf(
        "name" to "name", "fullname" to "name",
        "email" to "email", "emailaddress" to "email",
        "phone" to "phone", "phonenumber" to "phone",
        "postaladdress" to "postalAddress", "address" to "postalAddress",
        "shippingaddress" to "postalAddress",
    )

    val STATUSES: List<String> = listOf(
        "success", "failure", "invalidBillingAddress", "invalidShippingAddress",
        "invalidShippingContact", "pinRequired", "pinIncorrect", "pinLockout",
    )

    private val STATUS_ALIASES: Map<String, String> = mapOf(
        "success" to "success", "ok" to "success", "succeeded" to "success",
        "failure" to "failure", "failed" to "failure", "error" to "failure",
        "invalidbillingaddress" to "invalidBillingAddress",
        "invalidshippingaddress" to "invalidShippingAddress",
        "invalidshippingcontact" to "invalidShippingContact",
        "pinrequired" to "pinRequired", "pinincorrect" to "pinIncorrect",
        "pinlockout" to "pinLockout",
    )

    val MESSAGES: Map<String, String> = mapOf(
        "invalid_currency" to "That is not an ISO 4217 currency code.",
        "invalid_amount" to "That is not an amount this currency can express.",
        "no_items" to "A payment sheet needs at least one line item.",
        "total_mismatch" to "The line items do not add up to the total.",
        "missing_merchant" to "A payment needs a merchant identifier.",
        "unknown_network" to "That is not a card network this sheet knows.",
        "unknown_capability" to "That is not a merchant capability this sheet knows.",
        "unknown_field" to "That is not a field the sheet can collect.",
        "unknown_status" to "That is not an outcome the sheet understands.",
        "invalid_label" to "Every line the customer sees needs a label.",
    )

    /** A refusal carries a stable CODE and an optional human detail naming the offender. */
    class RefusalError(val code: String, val detail: String?) : Exception(code)

    private fun <T> refuse(code: String, detail: String? = null): Result<T> =
        Result.failure(RefusalError(code, detail))

    /** The refusal code behind any failure from this core. */
    fun code(error: Throwable): String = (error as? RefusalError)?.code ?: "invalid_amount"

    /** integer minor units; a negative line is a discount, which is legal on a line and not a total */
    data class Line(val label: String, val amountMinor: Long, val kind: String)

    data class Plan(
        val merchant: String,
        val currency: String,
        val exponent: Int,
        val items: List<Line>,
        val total: Line,
        val networks: List<String>,
        val capabilities: List<String>,
        val shipping: List<String>,
        val contact: List<String>,
    )

    private fun foldKey(raw: Any?): String =
        (raw?.toString() ?: "").lowercase().filter { !it.isWhitespace() && it != '-' && it != '_' }

    /** The minor-unit exponent for an ISO 4217 code, or -1 when the code is not one. */
    fun currencyExponent(raw: Any?): Int {
        val codeText = (raw?.toString() ?: "").trim().uppercase()
        if (codeText.length != 3 || codeText.any { it !in 'A'..'Z' }) return -1
        return CURRENCY_EXPONENTS[codeText] ?: 2
    }

    private fun pow10(n: Int): Long {
        var out = 1L
        repeat(n) { out *= 10L }
        return out
    }

    /**
     * Parse a money amount into integer minor units. Accepts a decimal string in the major
     * unit, or a number ONLY when it is whole. A fractional number is refused: `0.1` is not
     * `0.1` in binary, and a checkout off by a cent is unfixable after the fact.
     */
    fun parseAmountMinor(raw: Any?, exponent: Int): Result<Long> {
        if (exponent < 0) return refuse("invalid_currency")

        if (raw is Number) {
            val d = raw.toDouble()
            if (!d.isFinite()) return refuse("invalid_amount", "not a finite number")
            if (d != Math.floor(d)) {
                return refuse(
                    "invalid_amount",
                    "quote a fractional amount as a string — binary floats cannot hold it exactly",
                )
            }
            val minor = d.toLong() * pow10(exponent)
            if (Math.abs(minor) > MAX_MINOR) return refuse("invalid_amount", "out of range")
            return Result.success(minor)
        }

        val text = (raw as? String)?.trim() ?: ""
        val match = Regex("^([+-]?)(\\d+)(?:\\.(\\d+))?$").find(text)
            ?: return refuse("invalid_amount", "not a decimal amount")
        val sign = if (match.groupValues[1] == "-") -1L else 1L
        val whole = match.groupValues[2]
        val frac = match.groupValues[3]
        if (frac.length > exponent) {
            return refuse("invalid_amount", "this currency has $exponent decimal place(s)")
        }
        if (whole.length > 15) return refuse("invalid_amount", "out of range")
        val padded = (frac + "0".repeat(exponent)).substring(0, exponent)
        val minor = sign * (whole.toLong() * pow10(exponent) + if (exponent > 0) padded.toLong() else 0L)
        if (Math.abs(minor) > MAX_MINOR) return refuse("invalid_amount", "out of range")
        return Result.success(minor)
    }

    /** Render minor units back as the major-unit decimal string the sheet shows. Pinned so
     *  three renderers cannot disagree about whether it is `5`, `5.0` or `5.00`. */
    fun formatAmountMinor(minor: Long, exponent: Int): String {
        val negative = minor < 0
        val abs = Math.abs(minor)
        if (exponent <= 0) return (if (negative) "-" else "") + abs.toString()
        val unit = pow10(exponent)
        val whole = abs / unit
        val rest = abs - whole * unit
        return (if (negative) "-" else "") + whole.toString() + "." + rest.toString().padStart(exponent, '0')
    }

    private fun asList(raw: Any?): List<Any?> = when {
        raw is List<*> -> raw
        raw is String && raw.isNotEmpty() -> raw.split(",")
        else -> emptyList()
    }

    private fun foldVocabulary(
        raw: Any?,
        aliases: Map<String, String>,
        canonicalOrder: List<String>,
        refusalCode: String,
        fallback: List<String>,
    ): Result<List<String>> {
        val list = asList(raw)
        if (list.isEmpty()) return Result.success(fallback)
        val seen = HashSet<String>()
        for (entry in list) {
            val canonical = aliases[foldKey(entry)]
                ?: return refuse(refusalCode, entry?.toString() ?: "")
            seen.add(canonical)
        }
        return Result.success(canonicalOrder.filter { seen.contains(it) })
    }

    /** An empty request means "everything this device can do" — the only default that does
     *  not silently exclude a customer's card. */
    fun foldNetworks(raw: Any?): Result<List<String>> =
        foldVocabulary(raw, NETWORK_ALIASES, NETWORKS, "unknown_network", NETWORKS)

    fun foldCapabilities(raw: Any?): Result<List<String>> =
        foldVocabulary(raw, CAPABILITY_ALIASES, CAPABILITIES, "unknown_capability",
            listOf("threeDS", "debit", "credit"))

    fun foldFields(raw: Any?): Result<List<String>> =
        foldVocabulary(raw, FIELD_ALIASES, FIELDS, "unknown_field", emptyList())

    /** Unknown is refused rather than treated as failure: a typo that reads as "declined" is a
     *  support ticket nobody can explain. */
    fun foldStatus(raw: Any?): Result<String> {
        val text = raw?.toString() ?: ""
        val effective = if (text.trim().isEmpty()) "success" else text
        val canonical = STATUS_ALIASES[foldKey(effective)]
            ?: return refuse("unknown_status", effective)
        return Result.success(canonical)
    }

    private fun parseLine(raw: Any?, exponent: Int, allowPending: Boolean): Result<Line> {
        val map = raw as? Map<*, *> ?: return refuse("invalid_amount", "a line item must be an object")
        val label = (map["label"]?.toString() ?: "").trim()
        if (label.isEmpty()) return refuse("invalid_label", "every line the customer sees needs a label")
        val amount = parseAmountMinor(map["amount"], exponent)
        val minor = amount.getOrElse { e -> return Result.failure(e) }
        val kindRaw = foldKey(map["kind"] ?: map["type"] ?: "")
        val kind = if (kindRaw.isEmpty()) "final" else kindRaw
        if (kind != "final" && kind != "pending") return refuse("invalid_amount", "a line is `final` or `pending`")
        if (kind == "pending" && !allowPending) return refuse("invalid_amount", "the total cannot be pending")
        return Result.success(Line(label, minor, kind))
    }

    /**
     * Validate and normalize a payment request into the plan every platform sheet is built
     * from. THE SUM CHECK IS THE REASON THIS FUNCTION EXISTS: a request whose line items do not
     * add up to its total is the most common wallet bug, and each platform hides it
     * differently. Here it is `total_mismatch` before a sheet ever appears.
     *
     * A PENDING line (a shipping cost still being computed) is exempt from the sum, because its
     * amount is by definition not yet known. The total itself may never be pending.
     */
    fun normalizeRequest(raw: Map<String, Any?>): Result<Plan> {
        val merchant = (raw["merchant"]?.toString() ?: "").trim()
        if (merchant.isEmpty()) return refuse("missing_merchant")

        val currency = (raw["currency"]?.toString() ?: "").trim().uppercase()
        val exponent = currencyExponent(currency)
        if (exponent < 0) return refuse("invalid_currency", currency)

        val rawItems = raw["items"] as? List<*> ?: emptyList<Any?>()
        if (rawItems.isEmpty()) return refuse("no_items")

        val items = ArrayList<Line>(rawItems.size)
        for (entry in rawItems) {
            val line = parseLine(entry, exponent, true)
            items.add(line.getOrElse { e -> return Result.failure(e) })
        }

        val rawTotal = raw["total"] ?: return refuse("invalid_amount", "a payment sheet needs a total line")
        val totalLine = parseLine(rawTotal, exponent, false).getOrElse { e -> return Result.failure(e) }
        if (totalLine.amountMinor < 0) return refuse("invalid_amount", "a total cannot be negative")

        var sum = 0L
        for (item in items) {
            if (item.kind == "pending") continue
            sum += item.amountMinor
        }
        if (sum != totalLine.amountMinor) {
            return refuse(
                "total_mismatch",
                "items add up to ${formatAmountMinor(sum, exponent)} but the total says " +
                    formatAmountMinor(totalLine.amountMinor, exponent),
            )
        }

        val networks = foldNetworks(raw["networks"]).getOrElse { e -> return Result.failure(e) }
        val capabilities = foldCapabilities(raw["capabilities"]).getOrElse { e -> return Result.failure(e) }
        val shipping = foldFields(raw["shipping"]).getOrElse { e -> return Result.failure(e) }
        val contact = foldFields(raw["contact"]).getOrElse { e -> return Result.failure(e) }

        return Result.success(
            Plan(merchant, currency, exponent, items, totalLine, networks, capabilities, shipping, contact),
        )
    }
}
