//
//  BackgroundPlan.kt - the shared Core/Background pure core (:core, pure JVM): the
//  declaration fold, the constraint translation, the budget countdown, the run-record fold
//  and the release gate on `run`. The law is the corpus,
//  OpenSource/Conformance/background/*.json (parity/F08-background.md). The twin of the web
//  @despia-native/kernel background.ts and Swift Engine/iOS BackgroundPlan.swift.
//
//  Everything platform-shaped lives OUTSIDE this file: the Background module enqueues
//  WorkManager work here, submits BGTaskScheduler requests on iOS, and registers a service
//  worker sync on the web. Keeping the DECISION separate from the PLUMBING is what lets one
//  corpus judge three renderers.
//
//  HONESTY IS THE FEATURE. WorkManager will not run a periodic worker more often than every
//  15 minutes, Doze stretches that further, and OEM battery managers kill background work
//  outright; iOS BGTaskScheduler gives no timing guarantee at all. None of that is something
//  a framework can fix, so this core refuses to paper over it: minInterval is a floor that
//  gets clamped and REPORTED, and every run leaves a record.
//
package despia.engine

object BackgroundPlan {

    /** The declared kinds: `periodic` repeats no faster than the floor, `deferred` runs once
     *  when its constraints are met, `appRefresh` is the short pre-launch warm. */
    val KINDS: List<String> = listOf("periodic", "deferred", "appRefresh")

    /** The requirement vocabulary, in the canonical order every fold emits. */
    val REQUIREMENTS: List<String> =
        listOf("network", "unmeteredNetwork", "charging", "batteryNotLow", "storageNotLow", "idle")

    /** WorkManager's periodic floor. A shorter declaration is clamped, not refused. */
    const val PERIODIC_FLOOR_SECONDS: Int = 900

    /** The FIXED iOS scheduler buckets (see the web twin's note: a per-app generated
     *  BGTaskSchedulerPermittedIdentifiers list is a list that goes stale silently). */
    val BUCKETS: List<String> =
        listOf("refresh", "processing", "processing.net", "processing.power", "processing.net.power")

    /** The wall-clock budget one run gets, per platform. The platform's numbers, not ours. */
    val BUDGET_MS: Map<String, Long> = mapOf("ios" to 30_000L, "android" to 600_000L, "web" to 30_000L)

    /** A resolved task row: what the manifest declaration actually means. */
    data class Task(
        val id: String,
        val action: String,
        val kind: String,
        /** 0 for every non-periodic kind: only `periodic` carries a schedule. */
        val minIntervalSeconds: Int,
        /** True when a declared interval below the floor was raised to it. Reported, never hidden. */
        val clamped: Boolean,
        val requires: List<String>,
        val expedited: Boolean,
        val bucket: String,
    )

    /** Why a declaration was refused. Every one fails the BUILD (the facet fan-in types
     *  `action` as an ownAction, so a stale target aborts prepare), not the device. */
    enum class Refusal { INVALID_TASK_ID, UNKNOWN_TASK_ACTION, UNKNOWN_KIND, UNKNOWN_REQUIREMENT, INVALID_INTERVAL }

    /** The stable machine ids the module reports and the corpus pins. */
    fun code(refusal: Refusal): String = when (refusal) {
        Refusal.INVALID_TASK_ID -> "invalid_task_id"
        Refusal.UNKNOWN_TASK_ACTION -> "unknown_task_action"
        Refusal.UNKNOWN_KIND -> "unknown_kind"
        Refusal.UNKNOWN_REQUIREMENT -> "unknown_requirement"
        Refusal.INVALID_INTERVAL -> "invalid_interval"
    }

    /** Carries a [Refusal] out of [resolveTask] without allocating a stack trace per call. */
    class RefusalError(val refusal: Refusal) : Exception(code(refusal)) {
        override fun fillInStackTrace(): Throwable = this
    }

    /** The iOS bucket a row folds into: app refresh is its own short lane, everything else is
     *  a processing lane suffixed by whether it needs a network and whether it needs power. */
    fun bucket(kind: String, requires: List<String>): String {
        if (kind == "appRefresh") return "refresh"
        val network = requires.contains("network") || requires.contains("unmeteredNetwork")
        val power = requires.contains("charging")
        return "processing" + (if (network) ".net" else "") + (if (power) ".power" else "")
    }

    private val DIGITS = Regex("^\\d+$")

    private fun splitRequires(raw: String?): List<String>? {
        val words = (raw ?: "").split(",").map { it.trim() }.filter { it.isNotEmpty() }
        if (words.any { it !in REQUIREMENTS }) return null
        return REQUIREMENTS.filter { it in words }
    }

    /**
     * Fold one declared manifest row into a resolved task.
     *
     * [declaredActions] is the declaring module's own action list: a row naming anything else
     * is UNKNOWN_TASK_ACTION, the stale-target class the facet fan-in aborts on at prepare
     * time. Vocabulary is exact case - a case-insensitive vocabulary is one nobody can lint.
     */
    fun resolveTask(id: String?, row: Map<String, String?>?, declaredActions: List<String>): Result<Task> {
        val taskId = id?.trim().orEmpty()
        if (taskId.isEmpty()) return Result.failure(RefusalError(Refusal.INVALID_TASK_ID))
        val spec = row ?: emptyMap()

        val action = spec["action"]?.trim().orEmpty()
        if (action.isEmpty() || action !in declaredActions) {
            return Result.failure(RefusalError(Refusal.UNKNOWN_TASK_ACTION))
        }

        val kind = spec["kind"]?.trim().orEmpty()
        if (kind !in KINDS) return Result.failure(RefusalError(Refusal.UNKNOWN_KIND))

        val requires = splitRequires(spec["requires"])
            ?: return Result.failure(RefusalError(Refusal.UNKNOWN_REQUIREMENT))

        val rawInterval = spec["minInterval"]?.trim().orEmpty()
        var minIntervalSeconds = 0
        var clamped = false
        if (kind == "periodic") {
            if (rawInterval.isNotEmpty()) {
                if (!DIGITS.matches(rawInterval)) return Result.failure(RefusalError(Refusal.INVALID_INTERVAL))
                minIntervalSeconds = rawInterval.toIntOrNull()
                    ?: return Result.failure(RefusalError(Refusal.INVALID_INTERVAL))
            }
            if (minIntervalSeconds < PERIODIC_FLOOR_SECONDS) {
                clamped = minIntervalSeconds > 0
                minIntervalSeconds = PERIODIC_FLOOR_SECONDS
            }
        } else if (rawInterval.isNotEmpty() && !DIGITS.matches(rawInterval)) {
            return Result.failure(RefusalError(Refusal.INVALID_INTERVAL))
        }

        return Result.success(
            Task(
                id = taskId,
                action = action,
                kind = kind,
                minIntervalSeconds = minIntervalSeconds,
                clamped = clamped,
                requires = requires,
                expedited = spec["expedited"]?.trim() == "true",
                bucket = bucket(kind, requires),
            )
        )
    }

    /** The platform constraint objects a requirement set folds into. Three of the six words
     *  have no iOS twin, and the empty map records that honestly rather than pretending. */
    data class Constraints(val ios: Map<String, String>, val android: Map<String, String>)

    fun constraints(requires: List<String>): Constraints {
        val ios = LinkedHashMap<String, String>()
        val android = LinkedHashMap<String, String>()
        val network = requires.contains("network")
        val unmetered = requires.contains("unmeteredNetwork")
        if (network || unmetered) ios["requiresNetworkConnectivity"] = "true"
        if (unmetered) android["networkType"] = "UNMETERED" else if (network) android["networkType"] = "CONNECTED"
        if (requires.contains("charging")) {
            ios["requiresExternalPower"] = "true"
            android["requiresCharging"] = "true"
        }
        if (requires.contains("batteryNotLow")) android["requiresBatteryNotLow"] = "true"
        if (requires.contains("storageNotLow")) android["requiresStorageNotLow"] = "true"
        if (requires.contains("idle")) android["requiresDeviceIdle"] = "true"
        return Constraints(ios, android)
    }

    /** The live device facts a constraint set is folded against. */
    data class DeviceState(
        /** "none" | "metered" | "unmetered". */
        val network: String = "none",
        val charging: Boolean = false,
        val batteryLow: Boolean = false,
        val storageLow: Boolean = false,
        val idle: Boolean = false,
    )

    /** Which declared requirements the device does NOT currently meet, canonical order. An
     *  unmet task is not a failed task: it stays scheduled, and `status` names what is
     *  missing so an author sees why nothing has happened instead of guessing. */
    fun unmet(requires: List<String>, state: DeviceState): List<String> =
        REQUIREMENTS.filter { it in requires }.filter { word ->
            when (word) {
                "network" -> state.network == "none"
                "unmeteredNetwork" -> state.network != "unmetered"
                "charging" -> !state.charging
                "batteryNotLow" -> state.batteryLow
                "storageNotLow" -> state.storageLow
                "idle" -> !state.idle
                else -> false
            }
        }

    /** The wall clock left in this run, and whether the budget is spent. An action reads the
     *  first as dsx.module.background.context.remaining while it runs. */
    data class Budget(val remainingMs: Long, val expired: Boolean)

    fun budget(platform: String, elapsedMs: Long): Budget {
        val total = BUDGET_MS[platform] ?: BUDGET_MS.getValue("ios")
        val elapsed = if (elapsedMs > 0) elapsedMs else 0L
        val remaining = total - elapsed
        return Budget(if (remaining > 0) remaining else 0L, remaining <= 0)
    }

    /** What the last run actually did. `killed` is the outcome every other scheduler loses. */
    data class RunRecord(val result: String, val failure: Boolean, val running: Boolean)

    /**
     * Fold a run's lifecycle facts ("start" · "finish" · "fail" · "expire" · "relaunch") into
     * one honest record. The case that matters is `relaunch` while a run is in flight: the OS
     * killed the process mid-run, and without this the task would sit in `status` looking
     * like it had been running for three days.
     */
    fun runRecord(events: List<String>): RunRecord {
        var result = "never"
        var running = false
        for (event in events) {
            when (event) {
                "start" -> { running = true; result = "running" }
                "finish" -> if (running) { running = false; result = "success" }
                "fail" -> if (running) { running = false; result = "failed" }
                "expire" -> if (running) { running = false; result = "budget_exceeded" }
                "relaunch" -> if (running) { running = false; result = "killed" }
            }
        }
        val failure = result == "failed" || result == "budget_exceeded" || result == "killed"
        return RunRecord(result, failure, running)
    }

    /** The `run` action is DEBUG ONLY. A scheduler you can fake in production is a scheduler
     *  nobody trusts. Fails closed: an unclassifiable channel is production. */
    fun runAllowed(channel: String?): Boolean = when (channel?.trim()) {
        "simulator", "debug", "testflight", "adhoc" -> true
        else -> false
    }
}
