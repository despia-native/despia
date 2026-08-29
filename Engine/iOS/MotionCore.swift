//
//  MotionCore.swift — the keyframe sampler: `@keyframes` plus an `animation` shorthand, folded
//  to the property values one frame should show. Swift twin of `@despia-native/kernel motion-core.ts`
//  and `:core MotionCore.kt`, judged by the same corpus
//  (`OpenSource/Conformance/motion/keyframes.json`).
//
//  WHY IT EXISTS (runtime-pressure R28). `@keyframes` and `animation` parse, lint, sit in the
//  DSX-CSS property catalogue, and reach the generated native sheets VERBATIM — the IR in
//  DSXCSSStyles.generated.swift already carries every stop. Then CSSResolver falls through on
//  any at-rule that is not `@media` and the declarations are inert. The catalogue promised the
//  author motion on every target while two targets silently disagreed, which left DSX with no
//  way to express a LOOP or a STAGGER off the web.
//
//  WHAT IT DELIBERATELY IS NOT: a CSS animation engine. Only the COMPOSITOR properties the
//  native bridges can apply without a layout pass animate — `opacity` and the transform family
//  — and every other property in a keyframe is DROPPED and REPORTED rather than half-applied,
//  because an animated `width` that only moves on the web is the exact defect this ends.
//
//  Sampling is a PURE function of elapsed milliseconds, never a state machine: a display link, a
//  backgrounded app and a deterministic test all reduce to passing a different number.
//
//  Foundation only — no SwiftUI, no UIKit — so it type-checks in the Apple-free island lane.
//
import Foundation

public enum MotionCore {

    /// `animation-iteration-count: infinite`, as a number three languages can put in JSON.
    public static let infinite: Double = -1

    /// The only properties a keyframe may animate. Anything else is dropped and reported.
    public static let properties: [String] = ["opacity", "transform"]

    /// The attribute keys `animationSpec` reads — the bridged spelling of all nine `animation-*`
    /// properties in the DSX-CSS catalogue. A renderer keys its driving task on exactly these,
    /// so an author editing any one of them restarts the animation, which is what CSS does.
    public static let animationKeys: [String] = [
        "animation", "animationName", "animationDuration", "animationDelay",
        "animationEasing", "animationIterations", "animationDirection",
        "animationFill", "animationPlayState",
    ]

    public struct Spec: Equatable {
        public var name: String
        public var duration: Double        // milliseconds
        public var delay: Double           // milliseconds; negative starts part-way in
        public var easing: String
        public var iterations: Double      // or `infinite`
        public var direction: String       // normal | reverse | alternate | alternate-reverse
        public var fill: String            // none | forwards | backwards | both
        public var paused: Bool            // animation-play-state: the driver holds elapsed still
        public var none: Bool
    }

    public struct Stop: Equatable {
        public var offset: Double
        public var declarations: [String: String]
        public init(offset: Double, declarations: [String: String]) {
            self.offset = offset
            self.declarations = declarations
        }
    }

    public struct Sample: Equatable {
        public var values: [String: String]
        public var dropped: [String]
        public var active: Bool
    }

    private static let namedEasings: [String: [Double]] = [
        "linear": [0, 0, 1, 1],
        "ease": [0.25, 0.1, 0.25, 1],
        "ease-in": [0.42, 0, 1, 1],
        "ease-out": [0, 0, 0.58, 1],
        "ease-in-out": [0.42, 0, 0.58, 1],
    ]

    private static let directions: Set<String> = ["normal", "reverse", "alternate", "alternate-reverse"]
    private static let fills: Set<String> = ["none", "forwards", "backwards", "both"]

    private static let off = Spec(
        name: "", duration: 0, delay: 0, easing: "ease", iterations: 1,
        direction: "normal", fill: "none", paused: false, none: true,
    )

    /// Parse an `animation` shorthand. CSS orders it loosely: the FIRST time is the duration and
    /// the second is the delay, and every other word is identified by what it is. A word this
    /// cannot classify becomes the name, which is why `animation: 2s spin` and `animation: spin
    /// 2s` are the same declaration. The OFF spec is returned whole rather than merged onto a
    /// half-parse: `none == true` means every other field is a default.
    public static func parseAnimation(_ shorthand: String) -> Spec {
        let text = shorthand.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty || text == "none" { return off }

        var spec = off
        spec.none = false
        var seenTime = 0

        for word in splitTopLevel(text) {
            let lower = word.lowercased()
            if let time = parseTime(lower) {
                if seenTime == 0 { spec.duration = time } else if seenTime == 1 { spec.delay = time }
                seenTime += 1
                continue
            }
            if lower == "infinite" { spec.iterations = infinite; continue }
            if namedEasings[lower] != nil || lower.hasPrefix("cubic-bezier(") || lower.hasPrefix("steps(") {
                spec.easing = lower
                continue
            }
            if directions.contains(lower) { spec.direction = lower; continue }
            if fills.contains(lower), lower != "none" { spec.fill = lower; continue }
            if !lower.hasSuffix("s"), let count = Double(lower), count >= 0 {
                spec.iterations = count
                continue
            }
            if lower == "running" { spec.paused = false; continue }
            if lower == "paused" { spec.paused = true; continue }
            if spec.name.isEmpty { spec.name = word }
        }
        return spec.name.isEmpty ? off : spec
    }

    /// The spec an element's resolved attributes describe: the `animation` shorthand, then every
    /// longhand that overrides it. All nine `animation-*` properties sit in the DSX-CSS catalogue
    /// as Tier B, so all nine have to mean something here or the catalogue is lying again - which
    /// is the defect R28 exists to end, one layer down.
    ///
    /// A longhand ALONE is a complete declaration (`animation-name: spin; animation-duration:
    /// 2s`), so a name arriving that way turns the OFF spec on. That is CSS: the shorthand is a
    /// shorthand.
    public static func animationSpec(_ attrs: [String: String]) -> Spec {
        var spec = parseAnimation(attrs["animation"] ?? "")
        let name = attrs["animationName"]?.trimmingCharacters(in: .whitespaces)
        if let name, !name.isEmpty, name != "none" {
            spec.name = name
            spec.none = false
        }
        if let d = parseTime(lowerTrim(attrs["animationDuration"])) { spec.duration = d }
        if let d = parseTime(lowerTrim(attrs["animationDelay"])) { spec.delay = d }
        let easing = lowerTrim(attrs["animationEasing"])
        if !easing.isEmpty { spec.easing = easing }
        let iterations = lowerTrim(attrs["animationIterations"])
        if iterations == "infinite" {
            spec.iterations = infinite
        } else if !iterations.isEmpty, let count = Double(iterations), count >= 0 {
            spec.iterations = count
        }
        let direction = lowerTrim(attrs["animationDirection"])
        if directions.contains(direction) { spec.direction = direction }
        let fill = lowerTrim(attrs["animationFill"])
        if fills.contains(fill) { spec.fill = fill }
        switch lowerTrim(attrs["animationPlayState"]) {
        case "paused": spec.paused = true
        case "running": spec.paused = false
        default: break
        }
        if spec.name.isEmpty { spec.none = true }
        return spec
    }

    private static func lowerTrim(_ value: String?) -> String {
        (value ?? "").trimmingCharacters(in: .whitespaces).lowercased()
    }

    /// Normalize a `@keyframes` body into ordered stops. `from` is 0, `to` is 1, `40%` is 0.4,
    /// and one rule may carry several. Later stops at the same offset win: the cascade inside a
    /// keyframes block.
    public static func keyframeTimeline(_ rules: [(selector: String, declarations: [String: String])]) -> [Stop] {
        var byOffset: [Double: [String: String]] = [:]
        for rule in rules {
            for part in rule.selector.split(separator: ",") {
                guard let offset = parseOffset(part.trimmingCharacters(in: .whitespaces)) else { continue }
                var merged = byOffset[offset] ?? [:]
                for (k, v) in rule.declarations { merged[k] = v }
                byOffset[offset] = merged
            }
        }
        return byOffset.map { Stop(offset: $0.key, declarations: $0.value) }
            .sorted { $0.offset < $1.offset }
    }

    /// The values at `elapsed` milliseconds since the animation was installed.
    ///
    /// A zero-duration animation shows its LAST stop and stops being active, which is what a
    /// browser does and what keeps `animation: spin 0s` from dividing by zero. Before the delay
    /// the element shows the first stop only under `backwards`/`both`, and after the last
    /// iteration the last stop only under `forwards`/`both` — CSS's fill rules, because half of
    /// them would make an element jump at the end.
    public static func sampleMotion(_ timeline: [Stop], _ spec: Spec, _ elapsed: Double) -> Sample {
        let dropped = droppedProperties(timeline)
        if spec.none || timeline.isEmpty { return Sample(values: [:], dropped: dropped, active: false) }

        let isInfinite = spec.iterations == infinite
        let total = isInfinite ? Double.infinity : spec.duration * spec.iterations
        let since = elapsed - spec.delay

        if since < 0 {
            let fills = spec.fill == "backwards" || spec.fill == "both"
            let values = fills ? valuesAt(timeline, startFraction(spec)) : [:]
            return Sample(values: values, dropped: dropped, active: true)
        }
        if spec.duration <= 0 || (!isInfinite && since >= total) {
            let fills = spec.fill == "forwards" || spec.fill == "both"
            let values = fills ? valuesAt(timeline, endFraction(spec)) : [:]
            return Sample(values: values, dropped: dropped, active: false)
        }

        let iteration = Int(floor(since / spec.duration))
        let within = since.truncatingRemainder(dividingBy: spec.duration) / spec.duration
        let eased = ease(spec.easing, directed(within, iteration, spec.direction))
        return Sample(values: valuesAt(timeline, eased), dropped: dropped, active: true)
    }

    /// What a sampled frame becomes here, plus the transform functions that could not come.
    public struct Attributes {
        public var attributes: [String: String]
        public var unsupported: [String]
    }

    /// Turn a sampled frame into the style attributes the modifier ladder ALREADY applies.
    ///
    /// SwiftUI has no `transform` attribute and is not getting one for this: `Stack` has
    /// `opacity`, `rotation`, uniform `scale` and `offsetX`/`offsetY`, and those four are what
    /// its modifier ladder is built out of. So the driver DECOMPOSES rather than adding a
    /// parallel transform pipeline that would then disagree with the static `rotation=`/`scale=`
    /// an author can already write on the same element.
    ///
    /// The decomposition is exact or it is refused. CSS composes transform functions as a matrix
    /// chain, leftmost outermost, and the ladder is fixed at rotation -> scale -> offset (inner
    /// to outer). A uniform scale and a rotation about the same centre commute, so their order is
    /// free; a translate does not, so it must come first to mean the same thing. One occurrence
    /// per family, `px` translations, angle units CSS knows. Anything else yields NO attributes
    /// and is reported, for the same reason `dropped` exists.
    public static func motionAttributes(_ values: [String: String]) -> Attributes {
        var attributes: [String: String] = [:]
        var unsupported: [String] = []
        if let opacity = values["opacity"] { attributes["opacity"] = opacity }

        guard let transform = values["transform"] else {
            return Attributes(attributes: attributes, unsupported: unsupported)
        }
        guard let functions = parseTransform(transform) else {
            return Attributes(attributes: attributes,
                              unsupported: [transform.trimmingCharacters(in: .whitespaces)])
        }

        var x = 0.0
        var y = 0.0
        var scale: Double?
        var rotation: Double?
        var translated = false
        var shaped = false
        var refused = false
        func refuse(_ name: String) {
            refused = true
            if !unsupported.contains(name) { unsupported.append(name) }
        }

        for fn in functions {
            let name = fn.name.lowercased()
            switch name {
            case "translate", "translatex", "translatey":
                // A translate after a scale or a rotation is a different matrix than the ladder
                // builds, so it is refused rather than reordered.
                if translated || shaped { refuse(fn.name); continue }
                let lengths = fn.args.map { px($0) }
                if lengths.contains(where: { $0 == nil }) { refuse(fn.name); continue }
                if name == "translatex" { x = lengths.first.flatMap { $0 } ?? 0 }
                else if name == "translatey" { y = lengths.first.flatMap { $0 } ?? 0 }
                else {
                    x = lengths.count > 0 ? (lengths[0] ?? 0) : 0
                    y = lengths.count > 1 ? (lengths[1] ?? 0) : 0
                }
                translated = true
            case "scale":
                let a = fn.args.count > 0 ? fn.args[0] : nil
                let b = fn.args.count > 1 ? fn.args[1] : nil
                guard scale == nil, let first = a, first.unit == "",
                      b == nil || (b!.unit == "" && b!.n == first.n)
                else { refuse(fn.name); continue }
                scale = first.n
                shaped = true
            case "rotate", "rotatez":
                let degrees = fn.args.count == 1 ? deg(fn.args[0]) : nil
                guard rotation == nil, let angle = degrees else { refuse(fn.name); continue }
                rotation = angle
                shaped = true
            default:
                refuse(fn.name)
            }
        }
        if refused {
            return Attributes(attributes: attributes, unsupported: unsupported.sorted())
        }

        if translated {
            attributes["offsetX"] = format(x)
            attributes["offsetY"] = format(y)
        }
        if let scale { attributes["scale"] = format(scale) }
        if let rotation { attributes["rotation"] = format(rotation) }
        return Attributes(attributes: attributes, unsupported: unsupported)
    }

    /// A translation length in points. `0` is unitless in CSS; a percentage needs a box.
    private static func px(_ arg: TransformArg) -> Double? {
        if arg.unit == "px" { return arg.n }
        if arg.unit.isEmpty && arg.n == 0 { return 0 }
        return nil
    }

    /// An angle in degrees, in the units CSS writes them.
    private static func deg(_ arg: TransformArg) -> Double? {
        switch arg.unit {
        case "deg": return arg.n
        case "rad": return arg.n * 180 / Double.pi
        case "turn": return arg.n * 360
        case "grad": return arg.n * 360 / 400
        case "": return arg.n == 0 ? 0 : nil
        default: return nil
        }
    }

    /// Every property a timeline mentions that this engine will not animate, sorted and unique.
    public static func droppedProperties(_ timeline: [Stop]) -> [String] {
        var out = Set<String>()
        for stop in timeline {
            for property in stop.declarations.keys where !properties.contains(property) {
                out.insert(property)
            }
        }
        return out.sorted()
    }

    // MARK: - internals

    private static func directed(_ within: Double, _ iteration: Int, _ direction: String) -> Double {
        switch direction {
        case "reverse": return 1 - within
        case "alternate": return iteration % 2 == 0 ? within : 1 - within
        case "alternate-reverse": return iteration % 2 == 0 ? 1 - within : within
        default: return within
        }
    }

    private static func startFraction(_ spec: Spec) -> Double {
        spec.direction == "reverse" || spec.direction == "alternate-reverse" ? 1 : 0
    }

    private static func endFraction(_ spec: Spec) -> Double {
        let last = spec.iterations == infinite ? 0 : max(0, Int(ceil(spec.iterations)) - 1)
        return directed(1, last, spec.direction)
    }

    private static func valuesAt(_ timeline: [Stop], _ fraction: Double) -> [String: String] {
        var out: [String: String] = [:]
        for property in properties {
            let stops = timeline.filter { $0.declarations[property] != nil }
            if stops.isEmpty { continue }
            if let value = interpolate(stops, property, fraction) { out[property] = value }
        }
        return out
    }

    private static func interpolate(_ stops: [Stop], _ property: String, _ fraction: Double) -> String? {
        var before = stops[0]
        var after = stops[stops.count - 1]
        for stop in stops {
            if stop.offset <= fraction { before = stop }
            if stop.offset >= fraction { after = stop; break }
        }
        guard let a = before.declarations[property], let b = after.declarations[property] else { return nil }
        if after.offset == before.offset { return a }
        let t = (fraction - before.offset) / (after.offset - before.offset)
        return property == "opacity" ? mixNumber(a, b, t) : mixTransform(a, b, t)
    }

    private static func mixNumber(_ a: String, _ b: String, _ t: Double) -> String {
        guard let from = Double(a.trimmingCharacters(in: .whitespaces)),
              let to = Double(b.trimmingCharacters(in: .whitespaces)) else { return a }
        return format(from + (to - from) * t)
    }

    /// Transforms interpolate FUNCTION BY FUNCTION and only when both sides list the same
    /// functions in the same order, which is CSS's own rule. A mismatched pair snaps at the
    /// midpoint rather than blending to a shape the author never wrote.
    private static func mixTransform(_ a: String, _ b: String, _ t: Double) -> String {
        guard let from = parseTransform(a), let to = parseTransform(b), from.count == to.count else {
            return t < 0.5 ? a : b
        }
        var out: [String] = []
        for i in 0..<from.count {
            let f = from[i]
            let g = to[i]
            if f.name != g.name || f.args.count != g.args.count { return t < 0.5 ? a : b }
            var args: [String] = []
            for (j, value) in f.args.enumerated() {
                let other = g.args[j]
                if value.unit != other.unit { args.append(format(value.n) + value.unit) }
                else { args.append(format(value.n + (other.n - value.n) * t) + value.unit) }
            }
            out.append("\(f.name)(\(args.joined(separator: ", ")))")
        }
        return out.joined(separator: " ")
    }

    private struct TransformArg { var n: Double; var unit: String }
    private struct TransformFn { var name: String; var args: [TransformArg] }

    private static func parseTransform(_ source: String) -> [TransformFn]? {
        var out: [TransformFn] = []
        var name = ""
        var body = ""
        var inBody = false
        for ch in source {
            if ch == "(" { inBody = true; body = ""; continue }
            if ch == ")" {
                inBody = false
                var args: [TransformArg] = []
                for raw in body.split(separator: ",") {
                    let text = raw.trimmingCharacters(in: .whitespaces)
                    if text.isEmpty { continue }
                    let unit = trailingUnit(text)
                    let numberText = unit.isEmpty ? text : String(text.dropLast(unit.count))
                    guard let n = Double(numberText) else { return nil }
                    args.append(TransformArg(n: n, unit: unit))
                }
                out.append(TransformFn(name: name.trimmingCharacters(in: .whitespaces), args: args))
                name = ""
                continue
            }
            if inBody { body.append(ch) } else { name.append(ch) }
        }
        if out.isEmpty {
            return source.trimmingCharacters(in: .whitespaces) == "none" ? [] : nil
        }
        return out
    }

    private static func trailingUnit(_ text: String) -> String {
        var unit = ""
        for ch in text.reversed() {
            if (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || ch == "%" { unit.append(ch) }
            else { break }
        }
        return String(unit.reversed())
    }

    /// The cubic-bezier solve by bisection — the shape every engine uses.
    private static func ease(_ easing: String, _ t: Double) -> Double {
        if t <= 0 { return 0 }
        if t >= 1 { return 1 }
        // `linear` is IDENTITY, short-circuited rather than solved: the bisection converges to
        // about 1e-6, invisible on screen and very visible in a corpus of compared strings.
        if easing == "linear" { return t }
        if easing.hasPrefix("steps(") {
            let digits = easing.drop(while: { !$0.isNumber }).prefix(while: { $0.isNumber })
            let n = max(1, Int(digits) ?? 1)
            let count = Double(n)
            return easing.contains("start") ? ceil(t * count) / count : floor(t * count) / count
        }
        var p = namedEasings[easing]
        if p == nil, easing.hasPrefix("cubic-bezier(") {
            let inner = easing.dropFirst("cubic-bezier(".count).dropLast()
            p = inner.split(separator: ",").compactMap { Double($0.trimmingCharacters(in: .whitespaces)) }
        }
        guard let points = p, points.count == 4 else { return t }
        let x1 = points[0], y1 = points[1], x2 = points[2], y2 = points[3]
        func bez(_ a: Double, _ b: Double, _ u: Double) -> Double {
            let v = 1 - u
            return 3 * v * v * u * a + 3 * v * u * u * b + u * u * u
        }
        var lo = 0.0
        var hi = 1.0
        var u = t
        for _ in 0..<24 {
            let x = bez(x1, x2, u)
            if abs(x - t) < 1e-6 { break }
            if x < t { lo = u } else { hi = u }
            u = (lo + hi) / 2
        }
        return bez(y1, y2, u)
    }

    private static func parseTime(_ word: String) -> Double? {
        if word.hasSuffix("ms") { return Double(word.dropLast(2)) }
        if word.hasSuffix("s") { return Double(word.dropLast(1)).map { $0 * 1000 } }
        return nil
    }

    private static func parseOffset(_ selector: String) -> Double? {
        let lower = selector.lowercased()
        if lower == "from" { return 0 }
        if lower == "to" { return 1 }
        guard lower.hasSuffix("%"), let n = Double(lower.dropLast()) else { return nil }
        return min(1, max(0, n / 100))
    }

    /// Split on whitespace, but never inside `cubic-bezier(…)` or `steps(…)`.
    private static func splitTopLevel(_ source: String) -> [String] {
        var out: [String] = []
        var depth = 0
        var current = ""
        for ch in source {
            if ch == "(" { depth += 1 }
            if ch == ")" { depth -= 1 }
            if depth == 0, ch == " " || ch == "\t" || ch == "\n" {
                if !current.isEmpty { out.append(current); current = "" }
                continue
            }
            current.append(ch)
        }
        if !current.isEmpty { out.append(current) }
        return out
    }

    /// Four decimals, trailing zeros trimmed, negative zero normalised — the same rule the
    /// scroll-linked plane formats by, and for the same reason: three languages compare these
    /// strings against one corpus.
    private static func format(_ value: Double) -> String {
        if !value.isFinite { return "0" }
        let rounded = (abs(value) * 10000).rounded() / 10000 * (value < 0 ? -1 : 1)
        if rounded == 0 { return "0" }
        var text = String(format: "%.4f", rounded)
        while text.hasSuffix("0") { text.removeLast() }
        if text.hasSuffix(".") { text.removeLast() }
        return text == "-0" ? "0" : text
    }
}
