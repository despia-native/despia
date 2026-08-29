//
//  NotifyCore.swift - the shared Core/Notify pure core: the permission ladder (including
//  provisional authorization and the Settings-changed-while-backgrounded transition), the
//  TRIGGER RESOLVER, the Android channel-importance fold, the foreground-presentation
//  resolution and the tap-payload normalisation. The law is the corpus,
//  `OpenSource/Conformance/notify/*.json` (parity/F02-notifications.md); the Kotlin twin is
//  `:core` NotifyCore.kt and the web twin is @despia-native/kernel's notify.ts.
//
//  Everything platform-shaped lives OUTSIDE this file: UNUserNotificationCenter,
//  NotificationManagerCompat and the browser Notification API all ask this core WHAT to do and
//  then do it. That split is what lets one corpus judge three renderers.
//
//  THE THREE RULES THIS FILE EXISTS FOR:
//
//  1. A REMINDER MUST FIRE AT THE SAME INSTANT ON EVERY PLATFORM. Scheduling is pure date math,
//     and it is where a notification stack is quietly wrong on exactly one platform: an hour
//     early in March, twice on the first Sunday in November, never on a leap day. So the
//     resolver takes ZONE RULES as data - a base offset plus the instants at which it changes -
//     and never asks Calendar, DateFormatter or TimeZone anything.
//
//  2. PROVISIONAL AUTHORIZATION IS ONE FLAG. iOS will deliver quietly with no prompt at all and
//     then let the user promote it; it is the highest-conversion path in mobile and almost
//     nobody ships it, because it is one constant buried in a bitmask. Here it is
//     `PermissionRequest(provisional: true)`, and the escalation to full authorization is a real
//     transition with its own rule: a DECLINED escalation keeps the quiet grant.
//
//  3. AN UNDECLARED ANDROID CHANNEL IS A TYPED REFUSAL. Decided here rather than on the Android
//     side alone, because a cross-platform call site carries a channel id on every platform and
//     the answer must be the same everywhere: iOS ignores the id, Android 8+ refuses an
//     undeclared one, and the refusal NAMES it.
//
//  No UserNotifications import and no Calendar: this file is pure so the record lane can run it
//  headless and `swiftc -parse` can judge it off a Mac.
//
import Foundation

public enum NotifyCore {

    // MARK: - the permission ladder

    /// The authorization statuses, as the module reports them (never a platform enum).
    public static let statuses: [String] = ["undetermined", "denied", "provisional", "granted"]

    /// The option vocabulary, exact case. `provisional` is an option like the rest so that quiet
    /// authorization is one flag rather than a second API.
    public static let options: [String] = [
        "alert", "sound", "badge", "carPlay", "announcement", "critical", "provisional",
    ]

    /// What a request that names no option at all asks for.
    public static let defaultOptions: [String] = ["alert", "badge", "sound"]

    /// What each platform can actually honour. Anything else is dropped AND REPORTED - an app
    /// that asked for critical alerts and got ordinary ones has to be able to find that out.
    public static let platformOptions: [String: [String]] = [
        "ios": ["alert", "sound", "badge", "carPlay", "announcement", "critical", "provisional"],
        "android": ["alert", "sound", "badge"],
        "web": ["alert", "sound", "badge"],
    ]

    /// POST_NOTIFICATIONS became a runtime permission here. Below it there is nothing to ask.
    public static let androidRuntimePermissionSDK = 33

    /// `provisional` and `critical` are MODIFIERS, not content: they say HOW the authorization is
    /// obtained and how loud it may be, not what the notification is allowed to do. So naming one
    /// does not suppress the default alert/badge/sound.
    public static let modifierOptions: [String] = ["provisional", "critical"]

    public struct PermissionState: Equatable {
        public let status: String
        /// True once the OS has shown the full-authorization dialog. It shows it once.
        public let promptShown: Bool
        /// Apple grants the critical-alerts entitlement by application; without it the option is
        /// accepted by the API and silently does nothing. Nil = not known / not asked.
        public let criticalEntitled: Bool?

        public init(status: String, promptShown: Bool = false, criticalEntitled: Bool? = nil) {
            self.status = status
            self.promptShown = promptShown
            self.criticalEntitled = criticalEntitled
        }
    }

    public struct PermissionRequest: Equatable {
        public let provisional: Bool
        public let critical: Bool
        public let alert: Bool
        public let sound: Bool
        public let badge: Bool
        public let carPlay: Bool
        public let announcement: Bool

        public init(provisional: Bool = false, critical: Bool = false, alert: Bool = false,
                    sound: Bool = false, badge: Bool = false, carPlay: Bool = false,
                    announcement: Bool = false) {
            self.provisional = provisional
            self.critical = critical
            self.alert = alert
            self.sound = sound
            self.badge = badge
            self.carPlay = carPlay
            self.announcement = announcement
        }

        fileprivate func asked(_ word: String) -> Bool {
            switch word {
            case "alert":        return alert
            case "sound":        return sound
            case "badge":        return badge
            case "carPlay":      return carPlay
            case "announcement": return announcement
            case "critical":     return critical
            case "provisional":  return provisional
            default:             return false
            }
        }
    }

    /// prompt = show the dialog · authorize = the QUIET provisional grant, no dialog ·
    /// settle = answer with what is already held · refuse = a typed error.
    public struct PermissionPlan: Equatable {
        public let action: String
        public let prompted: Bool
        public let quiet: Bool
        /// True when this prompt is the provisional -> full conversion.
        public let escalation: Bool
        public let options: [String]
        public let dropped: [String]
        public let status: String?
        public let error: String?

        public init(action: String, prompted: Bool, quiet: Bool, escalation: Bool,
                    options: [String], dropped: [String],
                    status: String? = nil, error: String? = nil) {
            self.action = action
            self.prompted = prompted
            self.quiet = quiet
            self.escalation = escalation
            self.options = options
            self.dropped = dropped
            self.status = status
            self.error = error
        }
    }

    private static func requestedOptions(_ request: PermissionRequest) -> [String] {
        let content = options.filter { !modifierOptions.contains($0) }.filter { request.asked($0) }
        let modifiers = modifierOptions.filter { request.asked($0) }
        // A request that names no CONTENT option asks for the sensible default. A request that
        // names only options this platform cannot honour is NOT defaulted afterwards - it asked
        // for something specific, and the honest answer is an empty set plus the dropped list.
        let base = content.isEmpty ? defaultOptions : content
        return base + modifiers
    }

    /// Decide what a `permission(...)` call should do.
    ///
    /// The whole ladder in one function. `status` never reaches here: reading is a different verb
    /// and it must never be able to prompt.
    public static func permissionPlan(_ request: PermissionRequest,
                                      state: PermissionState,
                                      platform: String,
                                      sdk: Int = 0) -> PermissionPlan {
        guard let supported = platformOptions[platform] else {
            return PermissionPlan(action: "refuse", prompted: false, quiet: false,
                                  escalation: false, options: [], dropped: [],
                                  error: "unsupported_platform")
        }

        var dropped: [String] = []
        var granted: [String] = []
        for word in requestedOptions(request) {
            guard supported.contains(word) else { dropped.append(word); continue }
            // The entitlement is not a platform capability, it is a per-app grant, so it is
            // checked separately - and a missing one DROPS the option rather than refusing the
            // whole request, because that is exactly what the platform API does.
            if word == "critical" && state.criticalEntitled != true { dropped.append(word); continue }
            granted.append(word)
        }
        granted.sort()
        dropped.sort()

        let wantsProvisional = granted.contains("provisional")

        func settle(_ status: String) -> PermissionPlan {
            PermissionPlan(action: "settle", prompted: false, quiet: false, escalation: false,
                           options: granted, dropped: dropped, status: status)
        }
        func refuse(_ error: String) -> PermissionPlan {
            PermissionPlan(action: "refuse", prompted: false, quiet: false, escalation: false,
                           options: granted, dropped: dropped, error: error)
        }

        if platform == "android" && sdk < androidRuntimePermissionSDK {
            // NOTHING TO ASK. A user who switched the app's notifications off in system settings
            // still reads denied, and no in-app dialog can undo that - so it is a refusal
            // pointing at Settings rather than a prompt that will never appear.
            if state.status == "denied" { return refuse("permission_denied") }
            return settle("granted")
        }

        switch state.status {
        case "granted":
            return settle("granted")
        case "denied":
            return refuse("permission_denied")
        case "provisional":
            // Asking for quiet again while already quiet changes nothing. Asking for FULL is the
            // conversion, and it is the one prompt iOS will still show from here.
            if wantsProvisional { return settle("provisional") }
            return PermissionPlan(action: "prompt", prompted: true, quiet: false, escalation: true,
                                  options: granted, dropped: dropped)
        default:
            if wantsProvisional {
                return PermissionPlan(action: "authorize", prompted: false, quiet: true,
                                      escalation: false, options: granted, dropped: dropped)
            }
            return PermissionPlan(action: "prompt", prompted: true, quiet: false, escalation: false,
                                  options: granted, dropped: dropped)
        }
    }

    /// Fold the OS's answer to a prompt back into the state.
    ///
    /// A DECLINED ESCALATION IS NOT A LOST GRANT: an app that was delivering quietly and asked for
    /// more must still be delivering quietly afterwards. The naive `granted ? granted : denied`
    /// throws away a working feature to record the refusal of a different one, and the user never
    /// sees another notification.
    public static func applyPermission(_ state: PermissionState,
                                       action: String,
                                       escalation: Bool,
                                       granted: Bool) -> PermissionState {
        if action == "authorize" {
            return PermissionState(status: granted ? "provisional" : "denied",
                                   promptShown: state.promptShown,
                                   criticalEntitled: state.criticalEntitled)
        }
        if action == "prompt" {
            if escalation {
                return PermissionState(status: granted ? "granted" : "provisional",
                                       promptShown: true,
                                       criticalEntitled: state.criticalEntitled)
            }
            return PermissionState(status: granted ? "granted" : "denied",
                                   promptShown: true,
                                   criticalEntitled: state.criticalEntitled)
        }
        return state
    }

    public struct Observed: Equatable {
        public let state: PermissionState
        public let changed: Bool
        /// True exactly when the status moved. A permission event on every foreground is noise.
        public let broadcast: Bool
    }

    /// THE SETTINGS-CHANGED-WHILE-BACKGROUNDED TRANSITION.
    ///
    /// The user turns notifications off (or on) in Settings while the app is not running. A module
    /// that trusts its cached status then prompts into a void forever, or tells a settings screen
    /// that notifications are on when they are not. The OS reading always wins.
    ///
    /// `undetermined` from the OS means the app was reinstalled, so the spent-prompt memory resets
    /// with it - otherwise the module would believe it had already burned a dialog it now has back.
    public static func observePermission(_ state: PermissionState, osStatus: String) -> Observed {
        let status = statuses.contains(osStatus) ? osStatus : state.status
        let promptShown = status == "undetermined" ? false : state.promptShown
        return Observed(
            state: PermissionState(status: status, promptShown: promptShown,
                                   criticalEntitled: state.criticalEntitled),
            changed: status != state.status || promptShown != state.promptShown,
            broadcast: status != state.status
        )
    }

    // MARK: - time zones, as data

    public struct ZoneTransition: Equatable {
        public let at: Int
        public let offset: Int
        public init(at: Int, offset: Int) { self.at = at; self.offset = offset }
    }

    /// A zone is a base offset in MINUTES plus the instants at which it changes. Ordered by `at`.
    public struct ZoneRules: Equatable {
        public let base: Int
        public let transitions: [ZoneTransition]
        public init(base: Int, transitions: [ZoneTransition] = []) {
            self.base = base
            self.transitions = transitions
        }
    }

    public static let utc = ZoneRules(base: 0, transitions: [])

    private static let minuteMS = 60_000
    private static let hourMS = 3_600_000
    private static let dayMS = 86_400_000

    /// Floored integer division - Swift's `/` truncates toward zero, which is the wrong answer
    /// for every date computation that crosses the epoch.
    private static func floorDiv(_ a: Int, _ b: Int) -> Int {
        let q = a / b
        return (a % b != 0 && ((a < 0) != (b < 0))) ? q - 1 : q
    }

    private static func floorMod(_ a: Int, _ b: Int) -> Int { a - floorDiv(a, b) * b }

    public static func offsetAt(_ zone: ZoneRules, instant: Int) -> Int {
        var offset = zone.base
        for transition in zone.transitions {
            if instant >= transition.at { offset = transition.offset } else { break }
        }
        return offset
    }

    /// An instant, expressed as the epoch-ms value that PRINTS as local time when read as UTC.
    public static func toWall(_ zone: ZoneRules, instant: Int) -> Int {
        instant + offsetAt(zone, instant: instant) * minuteMS
    }

    /// A wall-clock value back to an instant.
    ///
    /// THE TWO CASES DATE MATH DIES ON:
    ///   GAP (spring forward) - the wall time does not exist. Answer the first instant that does,
    ///     i.e. the transition itself. A daily reminder that silently skips a day once a year is
    ///     worse than one that runs half an hour late once a year.
    ///   OVERLAP (fall back) - the wall time happens twice. Answer the EARLIER instant, once.
    ///     Firing on both is a duplicate; firing on the second is an hour late.
    public static func fromWall(_ zone: ZoneRules, wall: Int) -> Int? {
        var offsets: Set<Int> = [zone.base]
        for transition in zone.transitions { offsets.insert(transition.offset) }
        var best: Int?
        for offset in offsets.sorted() {
            let instant = wall - offset * minuteMS
            if offsetAt(zone, instant: instant) != offset { continue }
            if best == nil || instant < best! { best = instant }
        }
        if let best { return best }
        for transition in zone.transitions {
            let before = offsetAt(zone, instant: transition.at - 1)
            let after = transition.offset
            if after <= before { continue }
            let low = transition.at + before * minuteMS
            let high = transition.at + after * minuteMS
            if wall >= low && wall < high { return transition.at }
        }
        return nil
    }

    // MARK: - civil date arithmetic (no platform calendar, on any renderer)

    public struct Civil: Equatable {
        public let year: Int
        /// 1-12
        public let month: Int
        /// 1-31
        public let day: Int
        public let hour: Int
        public let minute: Int

        public init(year: Int, month: Int, day: Int, hour: Int, minute: Int) {
            self.year = year
            self.month = month
            self.day = day
            self.hour = hour
            self.minute = minute
        }
    }

    private static func isLeap(_ year: Int) -> Bool {
        (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
    }

    private static let monthLengths = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

    public static func daysInMonth(year: Int, month: Int) -> Int {
        month == 2 && isLeap(year) ? 29 : monthLengths[month - 1]
    }

    /// Days from 1970-01-01 to year-month-day, Howard Hinnant's civil_from_days inverted.
    public static func daysFromCivil(year: Int, month: Int, day: Int) -> Int {
        let y = year - (month <= 2 ? 1 : 0)
        let era = floorDiv(y, 400)
        let yoe = y - era * 400
        let doy = floorDiv(153 * (month + (month > 2 ? -3 : 9)) + 2, 5) + day - 1
        let doe = yoe * 365 + floorDiv(yoe, 4) - floorDiv(yoe, 100) + doy
        return era * 146097 + doe - 719468
    }

    /// The inverse: a day number back to a civil year/month/day.
    public static func civilFromDays(_ days: Int) -> (year: Int, month: Int, day: Int) {
        let z = days + 719468
        let era = floorDiv(z, 146097)
        let doe = z - era * 146097
        let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365
        let y = yoe + era * 400
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100)
        let mp = (5 * doy + 2) / 153
        let day = doy - (153 * mp + 2) / 5 + 1
        let month = mp + (mp < 10 ? 3 : -9)
        return (year: y + (month <= 2 ? 1 : 0), month: month, day: day)
    }

    /// 0 = Sunday. 1970-01-01 was a Thursday.
    public static func weekday(_ days: Int) -> Int { ((days % 7) + 11) % 7 }

    public static func wallOf(_ civil: Civil) -> Int {
        daysFromCivil(year: civil.year, month: civil.month, day: civil.day) * dayMS
            + civil.hour * hourMS + civil.minute * minuteMS
    }

    public static func civilOf(_ wall: Int) -> Civil {
        let days = floorDiv(wall, dayMS)
        let rest = wall - days * dayMS
        let ymd = civilFromDays(days)
        return Civil(year: ymd.year, month: ymd.month, day: ymd.day,
                     hour: rest / hourMS, minute: (rest % hourMS) / minuteMS)
    }

    // MARK: - cron

    /// The cron search is BOUNDED. A bound is what makes `0 12 30 2 *` answer "never" instead of
    /// hanging a scheduler on a date that does not exist. A shade over four years, so the leap-day
    /// case is inside it.
    public static let cronSearchDays = 1600

    public struct CronSpec: Equatable {
        public let minutes: [Int]
        public let hours: [Int]
        public let daysOfMonth: [Int]
        public let months: [Int]
        public let daysOfWeek: [Int]
        public let domRestricted: Bool
        public let dowRestricted: Bool
    }

    private static func isDigits(_ text: String) -> Bool {
        !text.isEmpty && text.allSatisfy { $0.isASCII && $0.isNumber }
    }

    private static func isSpace(_ c: Character) -> Bool {
        c == " " || c == "\t" || c == "\n" || c == "\r" || c == "\u{000B}" || c == "\u{000C}"
    }

    /// The `\s+` split, hand-rolled so all three runtimes agree on what a separator is. Only ever
    /// called with an already-trimmed string, so runs collapse and nothing empty survives - except
    /// the empty input itself, which stays ONE empty field, because a cron with no fields at all
    /// must fail the arity check rather than vanish into a zero-length list.
    private static func splitOnSpaces(_ text: String) -> [String] {
        if text.isEmpty { return [""] }
        var out: [String] = []
        var current = ""
        for c in text {
            if isSpace(c) {
                if !current.isEmpty { out.append(current); current = "" }
            } else {
                current.append(c)
            }
        }
        if !current.isEmpty { out.append(current) }
        return out
    }

    private static func parseCronField(_ text: String, low: Int, high: Int) -> [Int]? {
        var out: Set<Int> = []
        for part in text.components(separatedBy: ",") {
            if part.isEmpty { return nil }
            var body = part
            var step = 1
            if let slash = body.firstIndex(of: "/") {
                let stepText = String(body[body.index(after: slash)...])
                body = String(body[body.startIndex..<slash])
                guard isDigits(stepText), let parsed = Int(stepText) else { return nil }
                step = parsed
                if step <= 0 { return nil }
            }
            let from: Int
            let to: Int
            if body == "*" {
                from = low; to = high
            } else if body.contains("-") {
                let halves = body.components(separatedBy: "-")
                guard halves.count >= 2 else { return nil }
                let a = halves[0]
                let b = halves[1]
                guard isDigits(a), isDigits(b), let lo = Int(a), let hi = Int(b) else { return nil }
                from = lo; to = hi
                if from > to { return nil }
            } else {
                guard isDigits(body), let only = Int(body) else { return nil }
                from = only; to = only
            }
            if from < low || to > high { return nil }
            var value = from
            while value <= to { out.insert(value); value += step }
        }
        return out.sorted()
    }

    public static func parseCron(_ expression: String) -> CronSpec? {
        let fields = splitOnSpaces(expression.trimmingCharacters(in: .whitespacesAndNewlines))
        guard fields.count == 5 else { return nil }
        guard let minutes = parseCronField(fields[0], low: 0, high: 59),
              let hours = parseCronField(fields[1], low: 0, high: 23),
              let daysOfMonth = parseCronField(fields[2], low: 1, high: 31),
              let months = parseCronField(fields[3], low: 1, high: 12),
              let rawDow = parseCronField(fields[4], low: 0, high: 7) else { return nil }
        // 7 and 0 are both Sunday, everywhere cron is spoken.
        let daysOfWeek = Set(rawDow.map { $0 == 7 ? 0 : $0 }).sorted()
        return CronSpec(minutes: minutes, hours: hours, daysOfMonth: daysOfMonth, months: months,
                        daysOfWeek: daysOfWeek,
                        domRestricted: fields[2] != "*", dowRestricted: fields[4] != "*")
    }

    private static func cronDayMatches(_ spec: CronSpec, year: Int, month: Int, day: Int) -> Bool {
        guard spec.months.contains(month) else { return false }
        let dow = weekday(daysFromCivil(year: year, month: month, day: day))
        // Cron's classic OR: when BOTH day fields are restricted, either one matching is a match.
        if spec.domRestricted && spec.dowRestricted {
            return spec.daysOfMonth.contains(day) || spec.daysOfWeek.contains(dow)
        }
        if spec.domRestricted { return spec.daysOfMonth.contains(day) }
        if spec.dowRestricted { return spec.daysOfWeek.contains(dow) }
        return true
    }

    // MARK: - the trigger resolver

    public static let repeatUnits: [String] = ["hourly", "daily", "weekly", "monthly", "yearly"]

    /// `inSeconds` is the corpus/TS `in` (a Swift keyword).
    public struct Trigger {
        /// An epoch-ms number or an ISO-8601 instant string.
        public let at: Any?
        public let inSeconds: Double?
        public let cron: String?
        public let repeats: String?

        public init(at: Any? = nil, inSeconds: Double? = nil,
                    cron: String? = nil, repeats: String? = nil) {
            self.at = at
            self.inSeconds = inSeconds
            self.cron = cron
            self.repeats = repeats
        }
    }

    public struct FirePlan: Equatable {
        public let ok: Bool
        public let kind: String?
        public let fires: [Int]
        public let exhausted: Bool
        public let error: String?

        public init(ok: Bool, kind: String? = nil, fires: [Int] = [],
                    exhausted: Bool = false, error: String? = nil) {
            self.ok = ok
            self.kind = kind
            self.fires = fires
            self.exhausted = exhausted
            self.error = error
        }
    }

    private static let invalidTrigger = FirePlan(ok: false, error: "invalid_trigger")

    /// Only the shape the module accepts on the wire: an epoch-ms number, or an ISO-8601 instant
    /// with an explicit zone. A bare "2026-06-01 12:00" is refused rather than guessed at, because
    /// the guess is exactly the bug this whole file exists to prevent.
    public static func parseInstant(_ value: Any?) -> Int? {
        if let number = value as? Int { return number }
        if let number = value as? Double {
            guard number.isFinite else { return nil }
            return Int(number)   // truncates toward zero, like Math.trunc
        }
        guard let raw = value as? String else { return nil }
        // YYYY-MM-DD (T| ) HH:MM [:SS] [.mmm…] (Z|z|±HH:MM|±HHMM) - hand-rolled so the three
        // runtimes cannot disagree about what their regex engines accept.
        let chars = Array(raw.trimmingCharacters(in: .whitespacesAndNewlines))
        var i = 0

        func digits(_ count: Int) -> Int? {
            guard i + count <= chars.count else { return nil }
            var out = 0
            for k in 0..<count {
                guard let digit = chars[i + k].wholeNumberValue,
                      chars[i + k].isASCII, chars[i + k].isNumber else { return nil }
                out = out * 10 + digit
            }
            i += count
            return out
        }
        func literal(_ accepted: String) -> Bool {
            guard i < chars.count, accepted.contains(chars[i]) else { return false }
            i += 1
            return true
        }

        guard let year = digits(4), literal("-"),
              let month = digits(2), literal("-"),
              let day = digits(2), literal("Tt "),
              let hour = digits(2), literal(":"),
              let minute = digits(2) else { return nil }

        var second = 0
        if i < chars.count && chars[i] == ":" {
            i += 1
            guard let parsed = digits(2) else { return nil }
            second = parsed
        }
        var milli = 0
        if i < chars.count && chars[i] == "." {
            i += 1
            let start = i
            while i < chars.count, chars[i].isASCII, chars[i].isNumber { i += 1 }
            if i == start { return nil }
            var fraction = String(chars[start..<min(start + 3, i)])
            while fraction.count < 3 { fraction.append("0") }
            guard let parsed = Int(fraction) else { return nil }
            milli = parsed
        }
        var offsetMinutes = 0
        if i < chars.count && (chars[i] == "Z" || chars[i] == "z") {
            i += 1
        } else if i < chars.count && (chars[i] == "+" || chars[i] == "-") {
            let sign = chars[i] == "-" ? -1 : 1
            i += 1
            guard let zoneHour = digits(2) else { return nil }
            if i < chars.count && chars[i] == ":" { i += 1 }
            guard let zoneMinute = digits(2) else { return nil }
            offsetMinutes = sign * (zoneHour * 60 + zoneMinute)
        } else {
            return nil
        }
        guard i == chars.count else { return nil }
        guard month >= 1, month <= 12 else { return nil }
        guard day >= 1, day <= daysInMonth(year: year, month: month) else { return nil }
        guard hour <= 23, minute <= 59, second <= 60 else { return nil }
        return daysFromCivil(year: year, month: month, day: day) * dayMS
            + hour * hourMS + minute * minuteMS + second * 1000 + milli
            - offsetMinutes * minuteMS
    }

    private static func addMonths(year: Int, month: Int, count: Int) -> (year: Int, month: Int) {
        let index = year * 12 + (month - 1) + count
        return (year: floorDiv(index, 12), month: floorMod(index, 12) + 1)
    }

    /// Resolve a trigger to its next `count` fire instants.
    ///
    /// WALL CLOCK VERSUS INTERVAL, the distinction the corpus exists to pin: `hourly` is an
    /// INTERVAL - exactly 3600000 ms apart, straight through a DST transition. Every other unit is
    /// WALL CLOCK - a 09:00 daily reminder is still 09:00 the day the clocks move, so the gap
    /// between those two fires is 23 or 25 hours. Both are correct; they are different.
    public static func fireTimes(_ trigger: Trigger, from: Int,
                                 zone: ZoneRules?, count: Int) -> FirePlan {
        let rules = zone ?? utc
        let want = max(0, count)

        let cron = trigger.cron?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty
        let repeats = trigger.repeats?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty
        let seconds = trigger.inSeconds
        let hasAt = trigger.at != nil

        let anchors = (hasAt ? 1 : 0) + (seconds != nil ? 1 : 0) + (cron != nil ? 1 : 0)
        guard anchors == 1 else { return invalidTrigger }
        if cron != nil && repeats != nil { return invalidTrigger }   // a cron already repeats
        if let repeats, !repeatUnits.contains(repeats) { return invalidTrigger }

        if let cron {
            guard let spec = parseCron(cron) else { return invalidTrigger }
            return cronFires(spec, from: from, zone: rules, count: want)
        }

        let anchor: Int
        if hasAt {
            guard let parsed = parseInstant(trigger.at) else { return invalidTrigger }
            anchor = parsed
        } else {
            guard let delay = seconds, delay.isFinite, delay > 0 else { return invalidTrigger }
            anchor = from + Int((delay * 1000).rounded(.down) + ((delay * 1000).truncatingRemainder(dividingBy: 1) >= 0.5 ? 1 : 0))
        }

        guard let repeats else {
            // An `at` already in the past resolves to NOTHING rather than firing immediately. A
            // scheduler that fires a stale reminder the moment the app opens is how a user gets
            // yesterday's alarm at breakfast.
            return FirePlan(ok: true, kind: "once", fires: anchor > from ? [anchor] : [],
                            exhausted: false)
        }
        return repeatFires(anchor: anchor, unit: repeats, from: from, zone: rules, count: want)
    }

    private static func cronFires(_ spec: CronSpec, from: Int,
                                  zone: ZoneRules, count: Int) -> FirePlan {
        var fires: [Int] = []
        if count == 0 { return FirePlan(ok: true, kind: "repeating", fires: fires, exhausted: false) }
        let startWall = toWall(zone, instant: from)
        let startDay = floorDiv(startWall, dayMS)
        for offset in 0..<cronSearchDays {
            let ymd = civilFromDays(startDay + offset)
            if !cronDayMatches(spec, year: ymd.year, month: ymd.month, day: ymd.day) { continue }
            for hour in spec.hours {
                for minute in spec.minutes {
                    let wall = wallOf(Civil(year: ymd.year, month: ymd.month, day: ymd.day,
                                            hour: hour, minute: minute))
                    if wall <= startWall { continue }
                    guard let instant = fromWall(zone, wall: wall) else { continue }
                    if instant <= from { continue }
                    // The gap rule can map two distinct wall times onto the same instant (02:00
                    // and 02:30 both become 03:00 on the spring-forward day). One fire, not two.
                    if let last = fires.last, instant <= last { continue }
                    fires.append(instant)
                    if fires.count >= count {
                        return FirePlan(ok: true, kind: "repeating", fires: fires, exhausted: false)
                    }
                }
            }
        }
        return FirePlan(ok: true, kind: "repeating", fires: fires, exhausted: true)
    }

    private static func repeatFires(anchor: Int, unit: String, from: Int,
                                    zone: ZoneRules, count: Int) -> FirePlan {
        var fires: [Int] = []
        if count == 0 { return FirePlan(ok: true, kind: "repeating", fires: fires, exhausted: false) }

        if unit == "hourly" {
            var instant = anchor
            // Skip forward in whole hours rather than looping one at a time from a distant anchor.
            if instant <= from {
                let steps = floorDiv(from - instant, hourMS) + 1
                instant += steps * hourMS
            }
            while fires.count < count { fires.append(instant); instant += hourMS }
            return FirePlan(ok: true, kind: "repeating", fires: fires, exhausted: false)
        }

        let base = civilOf(toWall(zone, instant: anchor))
        let baseDays = daysFromCivil(year: base.year, month: base.month, day: base.day)
        var step = 0
        var guardCount = 0
        let guardLimit = (unit == "yearly" || unit == "monthly") ? 4000 : cronSearchDays * 2
        while fires.count < count && guardCount < guardLimit {
            guardCount += 1
            var year = base.year
            var month = base.month
            var day = base.day
            if unit == "daily" || unit == "weekly" {
                let days = baseDays + step * (unit == "weekly" ? 7 : 1)
                let ymd = civilFromDays(days)
                year = ymd.year; month = ymd.month; day = ymd.day
            } else if unit == "monthly" {
                let ym = addMonths(year: base.year, month: base.month, count: step)
                year = ym.year; month = ym.month
                day = base.day
                // SKIP, never clamp: "the 31st" means the 31st. Clamping to the 30th silently
                // invents a fire the author never asked for, and it is indistinguishable from a
                // bug in February.
                if day > daysInMonth(year: year, month: month) { step += 1; continue }
            } else {
                year = base.year + step
                day = base.day
                if day > daysInMonth(year: year, month: month) { step += 1; continue }   // 29 Feb
            }
            step += 1
            guard let instant = fromWall(zone, wall: wallOf(Civil(year: year, month: month, day: day,
                                                                  hour: base.hour, minute: base.minute)))
            else { continue }
            if instant <= from { continue }
            if let last = fires.last, instant <= last { continue }
            fires.append(instant)
        }
        return FirePlan(ok: true, kind: "repeating", fires: fires, exhausted: fires.count < count)
    }

    // MARK: - Android channels

    public struct Importance: Equatable {
        public let word: String
        public let android: Int
        public let ios: String
        public let headsUp: Bool
        public let sound: Bool
    }

    /// Six words, exact case. `android` is the real NotificationManager constant; `ios` is the
    /// UNNotificationInterruptionLevel the same intent maps to. `critical` is deliberately absent
    /// from the iOS column: it needs an Apple entitlement, and a channel word must never be the
    /// thing that silently asks for one.
    public static let importanceTable: [Importance] = [
        Importance(word: "none", android: 0, ios: "passive", headsUp: false, sound: false),
        Importance(word: "min", android: 1, ios: "passive", headsUp: false, sound: false),
        Importance(word: "low", android: 2, ios: "passive", headsUp: false, sound: false),
        Importance(word: "default", android: 3, ios: "active", headsUp: false, sound: true),
        Importance(word: "high", android: 4, ios: "timeSensitive", headsUp: true, sound: true),
        Importance(word: "max", android: 5, ios: "timeSensitive", headsUp: true, sound: true),
    ]

    public static let defaultImportance = "default"

    /// Channels arrived in Android 8. Below it a channel id is meaningless, not an error.
    public static let androidChannelSDK = 26

    /// `nil` is the typed refusal (`invalid_argument`): a word that is not an importance is never
    /// rounded to the nearest one.
    public static func importance(_ word: String?) -> Importance? {
        let trimmed = (word ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let wanted = trimmed.isEmpty ? defaultImportance : trimmed
        return importanceTable.first { $0.word == wanted }
    }

    public struct ChannelState: Equatable {
        public let importance: String
        /// The user changed this channel's importance themselves. Android then ignores the app.
        public let userSet: Bool
        public let blocked: Bool

        public init(importance: String, userSet: Bool = false, blocked: Bool = false) {
            self.importance = importance
            self.userSet = userSet
            self.blocked = blocked
        }
    }

    public struct ChannelFold: Equatable {
        public let ok: Bool
        public let importance: String?
        public let created: Bool
        public let changed: Bool
        public let lockedByUser: Bool
        public let blocked: Bool
        public let error: String?

        public init(ok: Bool, importance: String? = nil, created: Bool = false,
                    changed: Bool = false, lockedByUser: Bool = false, blocked: Bool = false,
                    error: String? = nil) {
            self.ok = ok
            self.importance = importance
            self.created = created
            self.changed = changed
            self.lockedByUser = lockedByUser
            self.blocked = blocked
            self.error = error
        }
    }

    /// What a `channels.set` will ACTUALLY produce.
    ///
    /// THE RULE EVERY LIBRARY GETS WRONG: once a channel exists, Android lets the app LOWER its
    /// importance and silently ignores every attempt to raise it, and it remembers a user's own
    /// choice forever - deleting and recreating the id does not reset it. So this is not an update,
    /// it is a negotiation, and the answer says what the channel will be rather than what was asked
    /// for. `lockedByUser` is what a settings screen needs in order to say "you turned this down"
    /// instead of rendering a control that does nothing.
    public static func channelFold(existing: ChannelState?, requested: String?) -> ChannelFold {
        guard let wanted = importance(requested) else {
            return ChannelFold(ok: false, error: "invalid_argument")
        }
        guard let existing else {
            return ChannelFold(ok: true, importance: wanted.word, created: true, changed: true,
                               lockedByUser: false, blocked: false)
        }
        let held = importance(existing.importance) ?? importanceTable[3]
        let lockedByUser = existing.userSet
        let blocked = existing.blocked
        if lockedByUser || wanted.android >= held.android {
            return ChannelFold(ok: true, importance: held.word, created: false, changed: false,
                               lockedByUser: lockedByUser, blocked: blocked)
        }
        return ChannelFold(ok: true, importance: wanted.word, created: false, changed: true,
                           lockedByUser: lockedByUser, blocked: blocked)
    }

    public struct ChannelRequirement: Equatable {
        public let ok: Bool
        public let channel: String?
        public let error: String?

        public init(ok: Bool, channel: String? = nil, error: String? = nil) {
            self.ok = ok
            self.channel = channel
            self.error = error
        }
    }

    /// The module's own channel, created at first use so that an app which never thinks about
    /// channels still works.
    public static let defaultChannel = "default"

    /// Can this notification be posted.
    ///
    /// On Android 8+ a post to a channel that was never created is DROPPED BY THE OS - no
    /// exception, no log line, no callback. That is the number-one cause of "push does not
    /// arrive". Refuse first, and NAME THE ID.
    public static func channelRequired(platform: String, sdk: Int,
                                       channel: String?, known: [String]) -> ChannelRequirement {
        guard platform == "android", sdk >= androidChannelSDK else {
            return ChannelRequirement(ok: true, channel: nil)
        }
        let id = (channel ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if id.isEmpty { return ChannelRequirement(ok: true, channel: defaultChannel) }
        if known.contains(id) { return ChannelRequirement(ok: true, channel: id) }
        return ChannelRequirement(ok: false, channel: id, error: "channel_required")
    }

    // MARK: - foreground presentation

    /// The four words, canonical order - which is the order they are reported in, never sorted.
    public static let presentationWords: [String] = ["alert", "sound", "badge", "list"]

    /// `banner` is what the platforms call it in their own settings UI.
    public static let presentationAliases: [String: String] = ["banner": "alert"]

    public struct Presentation: Equatable {
        public let ok: Bool
        public let present: [String]
        public let suppressed: Bool
        public let headsUp: Bool
        public let dropped: [String]
        public let degraded: [String]
        public let error: String?

        public init(ok: Bool, present: [String] = [], suppressed: Bool = false,
                    headsUp: Bool = false, dropped: [String] = [], degraded: [String] = [],
                    error: String? = nil) {
            self.ok = ok
            self.present = present
            self.suppressed = suppressed
            self.headsUp = headsUp
            self.dropped = dropped
            self.degraded = degraded
            self.error = error
        }
    }

    /// What a notification does while the app is open.
    ///
    /// THE DEFAULT IS NOTHING, on every platform, and it surprises every author. iOS makes it a
    /// delegate callback nobody implements; Android makes it a channel-importance question; the
    /// browser shows the notification but the page usually never hears about it. One word decides
    /// it everywhere.
    public static func presentation(configured: [String]?, claimed: Bool, platform: String,
                                    importanceWord: String? = nil) -> Presentation {
        var words: [String] = []
        for raw in configured ?? [] {
            let word = presentationAliases[raw] ?? raw
            guard presentationWords.contains(word) else {
                return Presentation(ok: false, error: "invalid_argument")
            }
            if !words.contains(word) { words.append(word) }
        }

        // A CLAIMED notify.received suppresses the system presentation, whatever was configured -
        // that is the entire point of a claimable hook.
        if claimed { return Presentation(ok: true, suppressed: true) }

        if platform == "android" {
            // The OS posts it regardless: `list` is implicit and cannot be configured away. A
            // heads-up needs BOTH the alert word and a high-importance channel, and the channel
            // wins.
            let present = presentationWords.filter { words.contains($0) || $0 == "list" }
            let level = importance(importanceWord) ?? importanceTable[3]
            let headsUp = words.contains("alert") && level.headsUp
            let degraded = (words.contains("alert") && !level.headsUp) ? ["alert"] : []
            return Presentation(ok: true, present: present, suppressed: false, headsUp: headsUp,
                                dropped: [], degraded: degraded)
        }

        if platform == "web" {
            // There is no notification list to land in. Say so rather than accepting the word.
            let dropped = words.contains("list") ? ["list"] : []
            let present = presentationWords.filter { words.contains($0) && $0 != "list" }
            return Presentation(ok: true, present: present, suppressed: false,
                                headsUp: present.contains("alert"), dropped: dropped)
        }

        let present = presentationWords.filter { words.contains($0) }
        return Presentation(ok: true, present: present, suppressed: false,
                            headsUp: present.contains("alert"))
    }

    // MARK: - the host seam

    /// THE FOREGROUND-PRESENTATION OVERRIDE the host answers `willPresent` from.
    ///
    /// `nil` means NOBODY CONFIGURED IT, and the host must keep its own pre-module answer - so a
    /// build with Core/Notify excluded is byte-identical to before the module existed (Article 7).
    /// The module writes it; the host reads it. Same shape, and the same reason, as
    /// `StackOrientation.activeMask`.
    ///
    /// Main-actor by convention: only the module writes it, and only from the main queue where the
    /// notification centre is configured.
    public private(set) static var activeForeground: [String]?

    /// Publish (or clear, with nil) the runtime override. Returns whether it changed.
    @discardableResult
    public static func setActiveForeground(_ words: [String]?) -> Bool {
        guard activeForeground != words else { return false }
        activeForeground = words
        return true
    }

    // MARK: - tap routing

    /// The platform constants for "the user tapped the notification body". Normalised AWAY, so
    /// that `if payload.actionId != nil` means what it reads like.
    public static let defaultActionIDs: [String] = [
        "com.apple.UNNotificationDefaultActionIdentifier", "android.intent.action.MAIN", "default",
    ]

    public static let dismissActionIDs: [String] = [
        "com.apple.UNNotificationDismissActionIdentifier",
    ]

    public struct RawOpen {
        public let id: String?
        public let actionID: String?
        public let userText: String?
        public let data: [String: Any]?

        public init(id: String? = nil, actionID: String? = nil,
                    userText: String? = nil, data: [String: Any]? = nil) {
            self.id = id
            self.actionID = actionID
            self.userText = userText
            self.data = data
        }
    }

    public struct OpenPayload {
        public let kind: String
        public let id: String
        public let data: [String: Any]
        public let coldStart: Bool
        public let actionID: String?
        public let userText: String?

        public init(kind: String, id: String, data: [String: Any], coldStart: Bool,
                    actionID: String? = nil, userText: String? = nil) {
            self.kind = kind
            self.id = id
            self.data = data
            self.coldStart = coldStart
            self.actionID = actionID
            self.userText = userText
        }
    }

    /// One tap arrives in four envelope shapes - plain, action button, text-input action, and a
    /// COLD START where the app was not running. All four end up here, or an app routes three of
    /// them and loses the fourth.
    public static func openPayload(_ raw: RawOpen, coldStart: Bool) -> OpenPayload {
        let id = raw.id ?? ""
        let actionID = raw.actionID ?? ""
        if dismissActionIDs.contains(actionID) {
            return OpenPayload(kind: "dismissed", id: id, data: [:], coldStart: coldStart)
        }
        let data = raw.data ?? [:]
        let named = !actionID.isEmpty && !defaultActionIDs.contains(actionID)
        // An EMPTY reply is still a reply, so `userText` rides whenever the platform gave us one.
        if named, let userText = raw.userText {
            return OpenPayload(kind: "opened", id: id, data: data, coldStart: coldStart,
                               actionID: actionID, userText: userText)
        }
        if named {
            return OpenPayload(kind: "opened", id: id, data: data, coldStart: coldStart,
                               actionID: actionID)
        }
        return OpenPayload(kind: "opened", id: id, data: data, coldStart: coldStart)
    }

    public static let pathBytes = 8192
    public static let urlBytes = 8192
    public static let eventBytes = 65536

    private static func utf8Length(_ text: String) -> Int {
        var total = 0
        for scalar in text.unicodeScalars {
            if scalar.value > 0xffff { total += 4 }
            else if scalar.value > 0x7ff { total += 3 }
            else if scalar.value > 0x7f { total += 2 }
            else { total += 1 }
        }
        return total
    }

    private static func hasControlCharacter(_ text: String) -> Bool {
        text.unicodeScalars.contains { $0.value < 0x20 || $0.value == 0x7f }
    }

    public struct RoutingRecord: Equatable {
        public let path: String?
        public let url: String?
    }

    /// The record `Mandatory/PushRouting` already consumes for a VENDOR open, produced for a
    /// first-party one.
    ///
    /// The bounds are restated rather than skipped: a first-party payload must not be the one that
    /// gets to bypass the checks a Firebase payload goes through. A field that fails a bound is
    /// dropped; the OPEN still happens, because losing the whole event over a bad deep link is a
    /// worse failure than losing the deep link.
    public static func routingRecord(data: [String: Any]?) -> RoutingRecord {
        let fields = data ?? [:]
        let rawPath = fields["path"] as? String ?? ""
        let rawURL = fields["url"] as? String ?? ""

        var path: String?
        if rawPath.hasPrefix("/"), !rawPath.hasPrefix("//"),
           !hasControlCharacter(rawPath), utf8Length(rawPath) <= pathBytes {
            path = rawPath
        }

        var url: String?
        let lower = rawURL.lowercased()
        if lower.hasPrefix("http://") || lower.hasPrefix("https://"),
           !hasControlCharacter(rawURL), utf8Length(rawURL) <= urlBytes {
            let afterScheme = rawURL.range(of: "://").map { String(rawURL[$0.upperBound...]) } ?? ""
            let authority = afterScheme.components(separatedBy: "/").first ?? ""
            // Credentials in a notification URL are how a phishing payload borrows an app's trust.
            if !authority.contains("@") { url = rawURL }
        }

        return RoutingRecord(path: path, url: url)
    }
}

private extension String {
    /// `nil` for an empty string, so a blank `cron`/`repeats` reads as absent rather than present.
    var nonEmpty: String? { isEmpty ? nil : self }
}
