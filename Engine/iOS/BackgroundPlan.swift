//
//  BackgroundPlan.swift - the shared Core/Background pure core: the declaration fold, the
//  constraint translation, the budget countdown, the run-record fold and the release gate on
//  `run`. The law is the corpus, `OpenSource/Conformance/background/*.json`
//  (parity/F08-background.md); the Kotlin twin is `:core` BackgroundPlan.kt and the web twin
//  is @despia/kernel's background.ts.
//
//  Everything platform-shaped lives OUTSIDE this file: the Background module submits
//  BGTaskScheduler requests here, enqueues WorkManager work on Android, and registers a
//  service worker sync on the web. Keeping the DECISION separate from the PLUMBING is what
//  lets one corpus judge three renderers.
//
//  HONESTY IS THE FEATURE. BGTaskScheduler gives NO timing guarantee: the OS learns usage
//  patterns and a task may run in twenty minutes or in two days. WorkManager will not run a
//  periodic worker more often than every 15 minutes, Doze stretches that further, and OEM
//  battery managers kill background work outright. None of that is something a framework can
//  fix, so this core refuses to paper over it: `minInterval` is a floor that gets clamped and
//  REPORTED, and every run leaves a record.
//
//  No UIKit, no BackgroundTasks import: this file is pure so the record lane can run it
//  headless.
//
import Foundation

public enum BackgroundPlan {

    /// The declared kinds: `periodic` repeats no faster than the floor, `deferred` runs once
    /// when its constraints are met, `appRefresh` is the short pre-launch warm.
    public static let kinds: [String] = ["periodic", "deferred", "appRefresh"]

    /// The requirement vocabulary, in the canonical order every fold emits.
    public static let requirements: [String] = [
        "network", "unmeteredNetwork", "charging", "batteryNotLow", "storageNotLow", "idle",
    ]

    /// WorkManager's periodic floor, applied on both platforms so one declaration means one
    /// thing. A shorter declaration is clamped, not refused.
    public static let periodicFloorSeconds: Int = 900

    /// The FIXED scheduler buckets. Every BGTaskScheduler identifier must appear in
    /// Info.plist `BGTaskSchedulerPermittedIdentifiers` before `didFinishLaunching` returns; a
    /// list generated per app from the task table is a list that goes stale silently, so the
    /// module ships these five constants and routes each declared task into its bucket.
    public static let buckets: [String] = [
        "refresh", "processing", "processing.net", "processing.power", "processing.net.power",
    ]

    /// The wall-clock budget one run gets, per platform. The platform's numbers, not ours, and
    /// neither is a guarantee: the OS may expire a run sooner, which is the same typed outcome.
    public static let budgetMS: [String: Int] = ["ios": 30_000, "android": 600_000, "web": 30_000]

    /// A resolved task row: what the manifest declaration actually means.
    public struct Task: Equatable {
        public let id: String
        public let action: String
        public let kind: String
        /// 0 for every non-periodic kind: only `periodic` carries a schedule.
        public let minIntervalSeconds: Int
        /// True when a declared interval below the floor was raised to it. Reported, never hidden.
        public let clamped: Bool
        public let requires: [String]
        public let expedited: Bool
        public let bucket: String

        public init(id: String, action: String, kind: String, minIntervalSeconds: Int,
                    clamped: Bool, requires: [String], expedited: Bool, bucket: String) {
            self.id = id
            self.action = action
            self.kind = kind
            self.minIntervalSeconds = minIntervalSeconds
            self.clamped = clamped
            self.requires = requires
            self.expedited = expedited
            self.bucket = bucket
        }
    }

    /// Why a declaration was refused. Every one of these fails the BUILD (the facet fan-in
    /// types `action` as an ownAction, so a stale target aborts prepare), not the device.
    public enum Refusal: String, Error, Equatable {
        case invalidTaskID = "invalid_task_id"
        case unknownTaskAction = "unknown_task_action"
        case unknownKind = "unknown_kind"
        case unknownRequirement = "unknown_requirement"
        case invalidInterval = "invalid_interval"

        /// The stable machine id the module reports and the corpus pins.
        public var code: String { rawValue }
    }

    /// The iOS bucket a row folds into: app refresh is its own short lane, everything else is
    /// a processing lane suffixed by whether it needs a network and whether it needs power.
    public static func bucket(kind: String, requires: [String]) -> String {
        if kind == "appRefresh" { return "refresh" }
        let network = requires.contains("network") || requires.contains("unmeteredNetwork")
        let power = requires.contains("charging")
        return "processing" + (network ? ".net" : "") + (power ? ".power" : "")
    }

    private static func digitsOnly(_ value: String) -> Bool {
        !value.isEmpty && value.allSatisfy { $0.isASCII && $0.isNumber }
    }

    private static func splitRequires(_ raw: String?) -> [String]? {
        let words = (raw ?? "").split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        for word in words where !requirements.contains(word) { return nil }
        return requirements.filter { words.contains($0) }
    }

    /// Fold one declared manifest row into a resolved task.
    ///
    /// `declaredActions` is the declaring module's own action list: a row naming anything else
    /// is `.unknownTaskAction`, the stale-target class the facet fan-in aborts on at prepare
    /// time. Vocabulary is exact case, because a case-insensitive vocabulary is one nobody can
    /// lint.
    public static func resolveTask(_ id: String?, row: [String: String]?,
                                   declaredActions: [String]) throws -> Task {
        let taskID = (id ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !taskID.isEmpty else { throw Refusal.invalidTaskID }
        let spec = row ?? [:]

        let action = (spec["action"] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !action.isEmpty, declaredActions.contains(action) else { throw Refusal.unknownTaskAction }

        let kind = (spec["kind"] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard kinds.contains(kind) else { throw Refusal.unknownKind }

        guard let requires = splitRequires(spec["requires"]) else { throw Refusal.unknownRequirement }

        let rawInterval = (spec["minInterval"] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        var minIntervalSeconds = 0
        var clamped = false
        if kind == "periodic" {
            if !rawInterval.isEmpty {
                guard digitsOnly(rawInterval), let parsed = Int(rawInterval) else { throw Refusal.invalidInterval }
                minIntervalSeconds = parsed
            }
            if minIntervalSeconds < periodicFloorSeconds {
                clamped = minIntervalSeconds > 0
                minIntervalSeconds = periodicFloorSeconds
            }
        } else if !rawInterval.isEmpty, !digitsOnly(rawInterval) {
            throw Refusal.invalidInterval
        }

        return Task(id: taskID, action: action, kind: kind,
                    minIntervalSeconds: minIntervalSeconds, clamped: clamped,
                    requires: requires,
                    expedited: (spec["expedited"] ?? "").trimmingCharacters(in: .whitespacesAndNewlines) == "true",
                    bucket: bucket(kind: kind, requires: requires))
    }

    /// The platform constraint objects a requirement set folds into. Three of the six words
    /// have no iOS twin, and the empty map records that honestly rather than pretending.
    public struct Constraints: Equatable {
        public let ios: [String: String]
        public let android: [String: String]
    }

    public static func constraints(_ requires: [String]) -> Constraints {
        var ios: [String: String] = [:]
        var android: [String: String] = [:]
        let network = requires.contains("network")
        let unmetered = requires.contains("unmeteredNetwork")
        if network || unmetered { ios["requiresNetworkConnectivity"] = "true" }
        if unmetered { android["networkType"] = "UNMETERED" } else if network { android["networkType"] = "CONNECTED" }
        if requires.contains("charging") {
            ios["requiresExternalPower"] = "true"
            android["requiresCharging"] = "true"
        }
        if requires.contains("batteryNotLow") { android["requiresBatteryNotLow"] = "true" }
        if requires.contains("storageNotLow") { android["requiresStorageNotLow"] = "true" }
        if requires.contains("idle") { android["requiresDeviceIdle"] = "true" }
        return Constraints(ios: ios, android: android)
    }

    /// The live device facts a constraint set is folded against.
    public struct DeviceState: Equatable {
        /// "none" | "metered" | "unmetered".
        public let network: String
        public let charging: Bool
        public let batteryLow: Bool
        public let storageLow: Bool
        public let idle: Bool

        public init(network: String = "none", charging: Bool = false, batteryLow: Bool = false,
                    storageLow: Bool = false, idle: Bool = false) {
            self.network = network
            self.charging = charging
            self.batteryLow = batteryLow
            self.storageLow = storageLow
            self.idle = idle
        }
    }

    /// Which declared requirements the device does NOT currently meet, in canonical order. An
    /// unmet task is not a failed task: it stays scheduled, and `status` names what is missing
    /// so an author sees why nothing has happened instead of guessing.
    public static func unmet(_ requires: [String], state: DeviceState) -> [String] {
        requirements.filter { requires.contains($0) }.filter { word in
            switch word {
            case "network":          return state.network == "none"
            case "unmeteredNetwork": return state.network != "unmetered"
            case "charging":         return !state.charging
            case "batteryNotLow":    return state.batteryLow
            case "storageNotLow":    return state.storageLow
            case "idle":             return !state.idle
            default:                 return false
            }
        }
    }

    /// The wall clock left in this run, and whether the budget is spent. An action reads the
    /// first as `dsx.module.background.context.remaining` while it runs.
    public struct Budget: Equatable {
        public let remainingMS: Int
        public let expired: Bool
    }

    public static func budget(platform: String, elapsedMS: Int) -> Budget {
        let total = budgetMS[platform] ?? budgetMS["ios"]!
        let elapsed = elapsedMS > 0 ? elapsedMS : 0
        let remaining = total - elapsed
        return Budget(remainingMS: remaining > 0 ? remaining : 0, expired: remaining <= 0)
    }

    /// What the last run actually did. `killed` is the outcome every other scheduler loses.
    public struct RunRecord: Equatable {
        public let result: String
        public let failure: Bool
        public let running: Bool
    }

    /// Fold a run's lifecycle facts ("start" · "finish" · "fail" · "expire" · "relaunch") into
    /// one honest record. The case that matters is `relaunch` while a run is in flight: the OS
    /// killed the process mid-run, and without this the task would sit in `status` looking like
    /// it had been running for three days.
    public static func runRecord(_ events: [String]) -> RunRecord {
        var result = "never"
        var running = false
        for event in events {
            switch event {
            case "start":    running = true; result = "running"
            case "finish":   if running { running = false; result = "success" }
            case "fail":     if running { running = false; result = "failed" }
            case "expire":   if running { running = false; result = "budget_exceeded" }
            case "relaunch": if running { running = false; result = "killed" }
            default:         break
            }
        }
        let failure = result == "failed" || result == "budget_exceeded" || result == "killed"
        return RunRecord(result: result, failure: failure, running: running)
    }

    /// The `run` action is DEBUG ONLY. A scheduler you can fake in production is a scheduler
    /// nobody trusts, and "just to be sure" is exactly how an app ships with background work
    /// the OS has never once exercised. Fails closed: an unclassifiable channel is production.
    public static func runAllowed(_ channel: String?) -> Bool {
        switch (channel ?? "").trimmingCharacters(in: .whitespacesAndNewlines) {
        case "simulator", "debug", "testflight", "adhoc": return true
        default: return false
        }
    }
}
