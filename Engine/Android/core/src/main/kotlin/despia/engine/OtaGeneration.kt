//
//  OtaGeneration.kt - the two decisions a device makes about an OTA generation BEFORE it
//  applies one (:core, pure JVM): is this device inside the staged rollout, and can the
//  installed binary actually run what the generation references. The law is the corpus,
//  OpenSource/Conformance/ota/rollout.json (parity/P05-ota.md 4b + 4c). The twin of Swift
//  OtaGeneration and the web @despia-native/kernel packages/kernel/src/ota.ts.
//
//  Everything platform-shaped lives OUTSIDE this file. Fetching, signing, the content store
//  and the anti-rollback high-water mark are RemoteBundleGate's business; this file is pure
//  arithmetic and comparison, which is exactly why one corpus can judge three renderers. A
//  device either takes an update or it does not, identically everywhere.
//
//  Two properties the design is built on:
//    - no coordination: the bucket is a hash of the device's own installation id, so a staged
//      rollout needs no server, no assignment call and no state anywhere;
//    - monotonic: the hash is stable, so raising the fraction only grows the population. A
//      device that took generation N at 10 percent still has it at 50 percent.
//
package despia.engine

object OtaGeneration {

    /** FNV-1a 32-bit constants. Not a cryptographic hash and not pretending to be one: this is
     *  a bucketing function, and it is FNV rather than SHA-256 because the gate is synchronous
     *  at load time while the web twin's only hash (crypto.subtle) is async-only. */
    private const val FNV_OFFSET_BASIS = 2166136261L
    private const val FNV_PRIME = 16777619L
    private const val MASK32 = 0xFFFFFFFFL
    const val BUCKET_DIVISOR = 4294967296.0   // 2^32

    /** The staged-rollout declaration a manifest carries:
     *  `{ "rollout": { "fraction": 0.1, "salt": "gen-8a3f" } }`. */
    data class Rollout(val fraction: Double, val salt: String)

    /** What the gate decided. Every value other than APPLY means the device keeps the
     *  generation it already has, and says why. There is no silent bypass. */
    enum class Verdict {
        APPLY, ROLLOUT_EXCLUDED, RUNTIME_TOO_OLD, RUNTIME_UNKNOWN,
        INVALID_ROLLOUT, INVALID_RUNTIME_VERSION, NO_INSTALLATION_ID,
    }

    /** The stable machine ids the gate reports and the corpus pins. */
    fun code(verdict: Verdict): String = when (verdict) {
        Verdict.APPLY -> "apply"
        Verdict.ROLLOUT_EXCLUDED -> "rollout_excluded"
        Verdict.RUNTIME_TOO_OLD -> "runtime_too_old"
        Verdict.RUNTIME_UNKNOWN -> "runtime_unknown"
        Verdict.INVALID_ROLLOUT -> "invalid_rollout"
        Verdict.INVALID_RUNTIME_VERSION -> "invalid_runtime_version"
        Verdict.NO_INSTALLATION_ID -> "no_installation_id"
    }

    /** The decision, plus the bucket when one was computed (for logging a held device honestly). */
    data class Decision(val verdict: Verdict, val bucket: Double? = null)

    // MARK: - The bucket

    /** FNV-1a 32-bit over the UTF-8 bytes of [text], as an unsigned value in a Long. */
    fun hash32(text: String): Long {
        var hash = FNV_OFFSET_BASIS
        for (byte in text.toByteArray(Charsets.UTF_8)) {
            hash = hash xor (byte.toLong() and 0xFF)
            hash = (hash * FNV_PRIME) and MASK32
        }
        return hash
    }

    /** This device's stable position in [0,1) for one salt. The salt is per generation, so
     *  changing it deliberately reshuffles the whole population. */
    fun bucket(installationId: String, salt: String): Double =
        hash32("$installationId:$salt") / BUCKET_DIVISOR

    /** Is this device inside the fraction? The edges are explicit rather than emergent: 1 takes
     *  every device including the highest bucket, 0 takes none including bucket zero. */
    fun rolloutApplies(installationId: String, salt: String, fraction: Double): Boolean = when {
        fraction >= 1.0 -> true
        fraction <= 0.0 -> false
        else -> bucket(installationId, salt) < fraction
    }

    // MARK: - runtimeVersion

    private data class Version(val core: List<Int>, val pre: List<String>)

    private val CORE_COMPONENT = Regex("^(0|[1-9][0-9]*)$")
    private val PRE_IDENTIFIER = Regex("^[0-9A-Za-z-]+$")
    private val NUMERIC_IDENTIFIER = Regex("^(0|[1-9][0-9]*)$")

    /** Parse a `runtimeVersion`, or null when it is not one. Semver 2.0.0 with the one
     *  concession every real version table needs: a missing minor or patch is zero, so "4" and
     *  "4.0.0" are the same contract. Nothing else is forgiven - no `v` prefix, no leading
     *  zeros, no fourth component - because a version this gate guesses at is a version that
     *  can let an OTA reach a binary missing the module it references. */
    private fun parse(raw: String?): Version? {
        var text = raw?.trim() ?: return null
        if (text.isEmpty()) return null

        val plus = text.indexOf('+')
        if (plus >= 0) text = text.substring(0, plus)   // build metadata takes no part in precedence
        if (text.isEmpty()) return null

        var pre = emptyList<String>()
        val dash = text.indexOf('-')
        if (dash >= 0) {
            val preText = text.substring(dash + 1)
            text = text.substring(0, dash)
            if (preText.isEmpty()) return null
            pre = preText.split(".")
            if (pre.any { it.isEmpty() || !PRE_IDENTIFIER.matches(it) }) return null
        }

        val parts = text.split(".")
        if (parts.isEmpty() || parts.size > 3) return null
        if (parts.any { !CORE_COMPONENT.matches(it) }) return null
        val core = (0..2).map { if (it < parts.size) parts[it].toInt() else 0 }
        return Version(core, pre)
    }

    /** True when [raw] is a version this gate will act on. */
    fun isParseableVersion(raw: String?): Boolean = parse(raw) != null

    /** -1 / 0 / 1, or null when either side is unparseable. */
    fun compareVersions(a: String?, b: String?): Int? {
        val left = parse(a) ?: return null
        val right = parse(b) ?: return null

        for (i in 0..2) {
            if (left.core[i] != right.core[i]) return if (left.core[i] < right.core[i]) -1 else 1
        }
        // A pre-release ranks below the release it leads to; two releases are equal.
        if (left.pre.isEmpty() && right.pre.isEmpty()) return 0
        if (left.pre.isEmpty()) return 1
        if (right.pre.isEmpty()) return -1

        val shared = minOf(left.pre.size, right.pre.size)
        for (i in 0 until shared) {
            val l = left.pre[i]
            val r = right.pre[i]
            if (l == r) continue
            val lNumeric = NUMERIC_IDENTIFIER.matches(l)
            val rNumeric = NUMERIC_IDENTIFIER.matches(r)
            // Numeric identifiers compare NUMERICALLY. Compared by length then ascii rather
            // than by parsing: leading zeros are already rejected, so the longer decimal is
            // the larger one, and no runtime's integer width can round a 40-digit build
            // number into agreeing with a different one.
            if (lNumeric && rNumeric) {
                if (l.length != r.length) return if (l.length < r.length) -1 else 1
                return if (l < r) -1 else 1
            }
            if (lNumeric != rNumeric) return if (lNumeric) -1 else 1   // numeric ranks below alphanumeric
            return if (l < r) -1 else 1                                // ascii order
        }
        if (left.pre.size == right.pre.size) return 0
        return if (left.pre.size < right.pre.size) -1 else 1           // a prefix ranks below its extension
    }

    /** Does the installed binary meet what the generation declares? null when either version is
     *  unparseable, so the caller reports `invalid_runtime_version` rather than deciding. */
    fun runtimeVersionSatisfied(required: String?, current: String?): Boolean? {
        val order = compareVersions(current, required) ?: return null
        return order >= 0
    }

    // MARK: - The gate

    /** Read a manifest's `rollout` block. Returns the declaration, or null when it is present
     *  but malformed. [present] tells a malformed block from an absent one. */
    private class RolloutRead(val present: Boolean, val value: Rollout?)

    private fun readRollout(raw: Any?): RolloutRead {
        if (raw == null) return RolloutRead(present = false, value = null)
        val map = raw as? Map<*, *> ?: return RolloutRead(present = true, value = null)
        val fraction = (map["fraction"] as? Number)?.toDouble()
            ?: return RolloutRead(present = true, value = null)
        if (!fraction.isFinite() || fraction < 0.0 || fraction > 1.0) return RolloutRead(present = true, value = null)
        val salt = map["salt"] as? String ?: return RolloutRead(present = true, value = null)
        return RolloutRead(present = true, value = Rollout(fraction, salt))
    }

    /**
     * The gate. `runtimeVersion` is checked FIRST: a generation the installed binary cannot run
     * is refused whatever the rollout says, because that refusal is the one that stops an OTA
     * referencing a module the binary does not contain, which is how OTA systems brick apps. A
     * held or refused generation always leaves the last good one in place.
     *
     * [manifest] is the generation's declaration (`runtimeVersion`, `rollout`) as decoded JSON;
     * [installedRuntimeVersion] and [installationId] are what this install is.
     */
    fun evaluate(
        manifest: Map<String, Any?>,
        installedRuntimeVersion: String?,
        installationId: String?,
    ): Decision {
        val declared = manifest["runtimeVersion"]
        if (declared != null) {
            val declaredText = declared as? String
            if (parse(declaredText) == null) return Decision(Verdict.INVALID_RUNTIME_VERSION)
            if (installedRuntimeVersion.isNullOrEmpty()) return Decision(Verdict.RUNTIME_UNKNOWN)
            val satisfied = runtimeVersionSatisfied(declaredText, installedRuntimeVersion)
                ?: return Decision(Verdict.INVALID_RUNTIME_VERSION)
            if (!satisfied) return Decision(Verdict.RUNTIME_TOO_OLD)
        }

        val rollout = readRollout(manifest["rollout"])
        if (rollout.present) {
            val value = rollout.value ?: return Decision(Verdict.INVALID_ROLLOUT)
            if (value.fraction >= 1.0) return Decision(Verdict.APPLY)
            if (value.fraction <= 0.0) return Decision(Verdict.ROLLOUT_EXCLUDED)
            if (installationId.isNullOrEmpty()) return Decision(Verdict.NO_INSTALLATION_ID)
            val position = bucket(installationId, value.salt)
            return Decision(
                if (position < value.fraction) Verdict.APPLY else Verdict.ROLLOUT_EXCLUDED,
                position)
        }

        return Decision(Verdict.APPLY)
    }
}
