// Fit.kt - will this model run well on THIS device.
//
// Copyright Despia. Licensed under the Apache License, Version 2.0.
//
// The Kotlin twin of bindings/ts/src/fit.ts, and the reason the corpus exists:
// this function is stated in prose in OpenSource/Conformance/ai/README.md and
// implemented three times, so the only thing keeping the three honest is a
// shared set of fixtures. It is ordered and first-match-wins.
//
// Two decisions carry the weight:
//
//   The limit is the PER-PROCESS one the probe reads, not "free RAM". Apps are
//   killed against that number, so a verdict computed against anything else is
//   a guess wearing a fact's clothes.
//
//   `mapped_mb` NEVER counts toward it. mmap'd weights are clean file-backed
//   pages the kernel can evict; counting them refuses models that run fine. It
//   rides the verdict as detail so a UI can explain thrash instead of lying.
//
//   The footprint is MEASURED when this device has measured it. Both numbers
//   the memory check can use live in one place (`calibrationFootprintMb`) so
//   that "estimate or fact" is a single decision with a single guard.

package com.despia.ai

data class Verdict(
    val verdict: String,
    val reason: String? = null,
    val decodeTps: Double? = null,
    val measured: Boolean = false,
    val mappedMb: Double? = null,
    /** The footprint the memory check actually ran against, measured or
     *  estimated. It rides every verdict because "too big by how much" is the
     *  question a refusal raises. */
    val footprintMb: Double? = null,
    /** `footprintMb` came from a real load ON THIS DEVICE. The footprint twin
     *  of `measured`. */
    val footprintMeasured: Boolean = false,
    /** A stored footprint measurement for this model on this device was
     *  DISCARDED as impossible, and the estimate was used instead. */
    val footprintRejected: Boolean = false,
    /** The requirements this verdict was computed against were DERIVED from a
     *  file size and a GGUF header rather than measured on a device.
     *
     *  Emitted on every runtime-added model and ABSENT on a shipped one, so the
     *  key answers two questions: absent means curated, `true` means added and
     *  still estimated, `false` means added and MEASURED on this device. Stated
     *  in both directions, like `measured`, because every corpus fixture is a
     *  SUBSET match and a fixture cannot assert a key that is not there. */
    val added: Boolean = false,
) {
    fun toJson(): Json {
        val fields = LinkedHashMap<String, Json>()
        fields["verdict"] = Json.Str(verdict)
        reason?.let { fields["reason"] = Json.Str(it) }
        decodeTps?.let {
            fields["decode_tps"] = Json.Num(it)
            fields["measured"] = Json.Bool(measured)
        }
        mappedMb?.let { fields["mapped_mb"] = Json.Num(it) }
        footprintMb?.let { fields["footprint_mb"] = Json.Num(it) }
        if (footprintMeasured) fields["footprint_measured"] = Json.Bool(true)
        if (footprintRejected) fields["footprint_rejected"] = Json.Bool(true)
        if (added) fields["predicted"] = Json.Bool(!footprintMeasured)
        return Json.Obj(fields)
    }
}

object Fit {
    private const val DEFAULT_MEMORY_MB = 4096.0
    private const val DEFAULT_DISK_MB = 64000.0

    /** The ceiling this app will ACTUALLY have. The iOS increased-memory-limit
     *  entitlement materially changes which models fit, so the module declares
     *  it and the refusal is computed against the real limit. */
    fun memoryLimitMb(device: Json): Double =
        if (device["increased_memory_limit"].bool() && device.has("increased_memory_limit_mb")) {
            device["increased_memory_limit_mb"].number()
        } else {
            if (device.has("available_memory_mb")) device["available_memory_mb"].number() else DEFAULT_MEMORY_MB
        }

    /**
     * The ceiling a footprint MEASUREMENT has to fall under to be believed.
     *
     * Physical memory when the probe reports it. When it does not, the
     * per-process limit stands in, and that is not a substitute chosen for
     * convenience: the measurement is taken after a load the app SURVIVED, and
     * a process resident above its own jetsam limit does not survive to report
     * anything. Using the limit is the stricter of the two, which is the right
     * way to be wrong here - a discarded good measurement costs an estimate, a
     * trusted bad one costs the process.
     */
    fun measurementCeilingMb(device: Json): Double {
        if (device.has("total_memory_mb")) {
            val physical = device["total_memory_mb"].number()
            if (physical.isFinite() && physical > 0) return physical
        }
        return memoryLimitMb(device)
    }

    /** The footprint a verdict is computed against, and where it came from. */
    data class FootprintChoice(val mb: Double?, val measured: Boolean, val rejected: Boolean)

    /**
     * Measured footprint, or the entry's estimate - one decision, one guard.
     *
     * `requirements.footprint_mb` is the ONLY estimated number an entry carries
     * (`disk_mb` is the file size and `mapped_mb` is what the loader maps), and
     * it is the one the OOM reaper acts on. Against the shipped catalog's
     * measured rows the derivation lands +45%, +25% and +92% high and 39% LOW
     * for gemma-3-4b-it-Q4_K_M, which is the direction that gets a process
     * killed. No coefficient fixes that, so the estimate is a placeholder for a
     * fact, and this is where the fact replaces it: the resident cost of the
     * FIRST SUCCESSFUL LOAD on THIS device, recorded beside `decode_tps` in the
     * same per-model, per-device calibration store.
     *
     * A MEASUREMENT IS NOT AUTOMATICALLY BETTER THAN AN ESTIMATE. A wrong one
     * is worse, because it carries the authority of having been observed: zero
     * would make everything fit, a negative number would too, and a reading in
     * bytes rather than MiB would refuse everything. Anything that is not a
     * finite, positive number at or below the ceiling is discarded.
     */
    fun calibrationFootprintMb(entry: Json, device: Json): FootprintChoice {
        val requirements = entry["requirements"]
        val estimate = if (requirements.has("footprint_mb")) requirements["footprint_mb"].number() else null
        val stored = device["calibrated"][entry["id"].string()]
        if (!stored.has("footprint_mb")) return FootprintChoice(estimate, measured = false, rejected = false)
        val raw = stored["footprint_mb"].number()
        if (!raw.isFinite() || raw <= 0) return FootprintChoice(estimate, measured = false, rejected = true)
        if (raw > measurementCeilingMb(device)) return FootprintChoice(estimate, measured = false, rejected = true)
        return FootprintChoice(raw, measured = true, rejected = false)
    }

    fun evaluate(entry: Json, device: Json, caps: Json, policy: Json): Verdict {
        val requirements = entry["requirements"]
        val mapped = if (requirements.has("mapped_mb")) requirements["mapped_mb"].number() else null
        // The footprint this verdict is computed against, and where it came
        // from. Resolved ONCE, above the ordering, so every return says the
        // same thing about the same number.
        val footprint = calibrationFootprintMb(entry, device)
        // Rides as detail exactly like `mapped_mb`: the ordering below is
        // untouched and still first-match-wins, but a surface that shows "runs
        // well" has to be able to show "we think" beside it. A MEASUREMENT
        // RETIRES IT - `footprint_mb` is the only estimated number in
        // `requirements`, so once this device has measured it there is nothing
        // left in the verdict that was predicted.
        val added = entry["origin"]["added"].bool()
        fun verdict(name: String, reason: String? = null,
                    decodeTps: Double? = null, measured: Boolean = false): Verdict =
            Verdict(name, reason, decodeTps = decodeTps, measured = measured, mappedMb = mapped,
                    footprintMb = footprint.mb, footprintMeasured = footprint.measured,
                    footprintRejected = footprint.rejected, added = added)

        // 1. Can this build serve the entry at all? A catalog is a fleet-wide
        //    document; a row this build cannot serve is typed absence, not failure.
        val requires = entry["requires"]
        if (requires.has("abi") && requires["abi"].int() > caps["abi"].int()) {
            return verdict("unsupported", "requires_newer_abi")
        }
        val features = caps["features"].strings()
        if (requires["engine_caps"].strings().any { it !in features }) {
            return verdict("unsupported", "missing_engine_caps")
        }
        entry["engine"].stringOrNull()?.let {
            if (it !in caps["engines"].strings()) return verdict("unsupported", "engine_not_carried")
        }
        entry["format"].stringOrNull()?.let {
            if (it !in caps["formats"].strings()) return verdict("unsupported", "format_not_carried")
        }

        // 2. Crash containment: a model whose marker survived a launch is refused
        //    until the user clears it, so a bad pair cannot become a crash loop.
        val id = entry["id"].string()
        if (id in device["quarantined"].strings()) return verdict("quarantined", "crash_marker")

        // 3. Disk, before any byte moves.
        val freeDisk = if (device.has("free_disk_mb")) device["free_disk_mb"].number() else DEFAULT_DISK_MB
        if (requirements.has("disk_mb") && requirements["disk_mb"].number() > freeDisk) {
            return verdict("too_big", "disk")
        }

        // 4. Footprint against the real process limit - the MEASURED footprint
        //    when this device has one, the entry's estimate otherwise. Mapped
        //    size is NOT here.
        if (footprint.mb != null && footprint.mb > memoryLimitMb(device)) {
            return verdict("too_big", "memory")
        }

        // 5. Speed. The shipped band is a prior; a measurement from this device
        //    is the truth and replaces it, in BOTH directions.
        val calibrated = device["calibrated"][id]
        val measuredTps = if (calibrated.has("decode_tps")) calibrated["decode_tps"].number() else null
        val prior = entry["perf_priors"][device["class"].string()]
        val priorTps = if (prior.has("decode_tps")) prior["decode_tps"].number() else null
        val tps = measuredTps ?: priorTps
        val floor = if (policy.has("slow_decode_tps")) policy["slow_decode_tps"].number() else null

        if (tps != null && floor != null && tps < floor) {
            return verdict("runs_slow", decodeTps = tps, measured = measuredTps != null)
        }
        return verdict("runs_well", decodeTps = tps, measured = measuredTps != null)
    }

    private val RANK = mapOf("runs_well" to 2, "runs_slow" to 1)

    /** Anything that is not runs_well or runs_slow never routes: too_big,
     *  unsupported and quarantined are not degrees of "works". */
    fun meetsFloor(verdict: String, floor: String?): Boolean {
        val have = RANK[verdict] ?: 0
        if (have == 0) return false
        return have >= (RANK[floor ?: "runs_slow"] ?: 1)
    }
}
