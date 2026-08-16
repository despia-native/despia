//
//  SceneAnim.swift - the DSX Scene animation system, the Swift twin of the web kernel's
//  scene/anim.ts (dsx-scene.md P5), Foundation-only and corpus-pinned
//  (OpenSource/Conformance/scene/animation.json). THE SEMANTICS LAW: an animation
//  produces a value that OVERRIDES the authored/bound base value of ONE property while
//  active; when it ends, the property returns to base (or holds, per fill="hold"). Two
//  shapes share this evaluator:
//
//  - IMPLICIT TRANSITIONS — `transition="position 300ms ease-out, color 200ms"` on any
//    scene node: when the property's resolved BASE value changes, the rendered value
//    RETARGETS from its CURRENT RENDERED value to the new base over the duration (the
//    CSS transition model: interrupt = start from where you are, never snap, never
//    queue). A store write glides.
//  - EXPLICIT TWEENS — `<animate target from to duration delay easing loop when fill
//    on:done/>` as a CHILD of the node it animates.
//
//  EASING IS PINNED MATH (the exact constants and formulas live in the corpus README):
//  linear; ease/ease-in/ease-out/ease-in-out as the CSS cubic-bezier constants (solved
//  by EXACTLY 60 bisection iterations — deterministic across IEEE-double runtimes); and
//  spring(stiffness, damping), the analytic mass-1 damped spring evaluated on the REAL
//  clock (duration is ignored; the clip ends at the pinned settle time). Vector and
//  color properties interpolate COMPONENTWISE — colors on the LINEAR-RGB value plane.
//
//  DETERMINISM: value(t) is a pure function of the spec + start state — that is what
//  the corpus samples pin to 6 decimals. The RUNTIME law (animations ride the existing
//  kernel frame clock; the loop runs only while at least one animation is active or an
//  on:frame handler exists) belongs to the SceneElement adapter, not this module.
//

import Foundation

// ── easing: the pinned curves ────────────────────────────────────────────────────────

/// `linear` · a CSS cubic-bezier keyword · `spring(stiffness, damping)`
enum SceneEasing {
    case linear
    case bezier(x1: Double, y1: Double, x2: Double, y2: Double)
    case spring(stiffness: Double, damping: Double)
}

/// the loop word: absent/false · true (infinite) · a positive integer N · "pingpong"
enum SceneLoop {
    case none
    case infinite
    case count(Int)
    case pingpong
}

/// one parsed `<animate>` — the pure spec sceneTweenValue samples
struct SceneTweenSpec {
    let target: String
    /// nil = capture the BASE value at clip start (the from-default law)
    let from: [Double]?
    let to: [Double]
    let durationMs: Double
    let delayMs: Double
    let easing: SceneEasing
    let loop: SceneLoop
    let fill: String   // none | hold
}

struct SceneTweenSample {
    /// the rendered value of the target property at t
    let value: [Double]
    /// true while the animation is producing the value (false = the property shows base)
    let overriding: Bool
    /// true once the clip has COMPLETED (loop none/count exhausted) — on:done fires on
    /// the false→true edge, once, never per loop iteration
    let done: Bool
}

/// one `transition=` entry: `<property> <duration> [easing] [delay]`
struct SceneTransitionEntry {
    let property: String
    let durationMs: Double
    let easing: SceneEasing
    let delayMs: Double
}

/// one in-flight retarget: rendered glides from `from` toward `to`; startMs is the
/// base-change instant
struct SceneTransitionState {
    let from: [Double]
    let to: [Double]
    let startMs: Double
}

enum SceneAnim {

    /// the CSS keyword constants, verbatim
    static let easeConstants: [String: [Double]] = [
        "ease": [0.25, 0.1, 0.25, 1],
        "ease-in": [0.42, 0, 1, 1],
        "ease-out": [0, 0, 0.58, 1],
        "ease-in-out": [0.42, 0, 0.58, 1],
    ]

    static let springDefaultStiffness = 100.0
    static let springDefaultDamping = 10.0

    /// THE SUPPORTED TARGET SET, closed: position · rotation · scale (vec3) · color
    /// (linear-RGB triple) · intensity · fov (scalars). opacity is a NAMED ABSENCE —
    /// the scene material plane has no opacity channel.
    static let animTargets: Set<String> = ["position", "rotation", "scale", "color", "intensity", "fov"]

    private static func easeKeyword(_ name: String) -> SceneEasing {
        let c = easeConstants[name] ?? [0.25, 0.1, 0.25, 1]
        return .bezier(x1: c[0], y1: c[1], x2: c[2], y2: c[3])
    }

    /// `linear` · a CSS keyword · `spring(stiffness,damping)` (either arg omissible —
    /// `spring()` = spring(100,10)). Malformed → `ease` with one diagnostic. The spring
    /// arg grammar mirrors the TS regex: at most two args, no internal whitespace,
    /// empty = the default, both finite and > 0.
    static func parseEasing(_ raw: String, _ diag: ((SceneDiagnostic) -> Void)? = nil) -> SceneEasing {
        let text = raw.trimmingCharacters(in: .whitespaces)
        if text.isEmpty || text == "ease" { return easeKeyword("ease") }
        if text == "linear" { return .linear }
        if easeConstants[text] != nil { return easeKeyword(text) }
        if text.hasPrefix("spring("), text.hasSuffix(")") {
            let inner = String(text.dropFirst(7).dropLast(1))
            let parts = inner.components(separatedBy: ",")
            if parts.count <= 2, !inner.contains("("), !inner.contains(")") {
                let args = parts.map { $0.trimmingCharacters(in: .whitespaces) }
                if args.allSatisfy({ !$0.contains(where: { $0.isWhitespace }) }) {
                    let stiffness: Double? = args[0].isEmpty ? springDefaultStiffness : Double(args[0])
                    let damping: Double? = (args.count < 2 || args[1].isEmpty) ? springDefaultDamping : Double(args[1])
                    if let s = stiffness, s.isFinite, s > 0, let d = damping, d.isFinite, d > 0 {
                        return .spring(stiffness: s, damping: d)
                    }
                }
            }
        }
        diag?(SceneDiagnostic(code: "malformed-animation",
                              message: "easing=\"\(raw)\" is not a known easing — using ease"))
        return easeKeyword("ease")
    }

    /// cubic-bezier((0,0) P1 P2 (1,1)) sampled at parameter s
    private static func bezierAxis(_ s: Double, _ c1: Double, _ c2: Double) -> Double {
        let inverse = 1 - s
        return 3 * inverse * inverse * s * c1 + 3 * inverse * s * s * c2 + s * s * s
    }

    /// THE PINNED SOLVER: find s with x(s) = u by EXACTLY 60 bisection iterations on
    /// s ∈ [0, 1] (x is monotone for CSS-legal x1/x2 ∈ [0, 1]) — deterministic on every
    /// IEEE-double runtime, then return y(s).
    static func bezier(_ u: Double, _ x1: Double, _ y1: Double, _ x2: Double, _ y2: Double) -> Double {
        if u <= 0 { return 0 }
        if u >= 1 { return 1 }
        var lo = 0.0
        var hi = 1.0
        for _ in 0..<60 {
            let mid = (lo + hi) / 2
            if bezierAxis(mid, x1, x2) < u { lo = mid } else { hi = mid }
        }
        let s = (lo + hi) / 2
        return bezierAxis(s, y1, y2)
    }

    /// THE SPRING LAW: the analytic mass-1 damped spring from 0 to 1 (initial position
    /// 0, initial velocity 0) at REAL elapsed seconds t. ωₙ = √stiffness,
    /// ζ = damping/(2·√stiffness).
    /// ζ<1: 1 − e^(−ζωₙt)·(cos(ω_d t) + (ζωₙ/ω_d)·sin(ω_d t)) with ω_d = ωₙ√(1−ζ²);
    /// ζ=1: 1 − e^(−ωₙt)·(1 + ωₙt);
    /// ζ>1: 1 − (s₂·e^(s₁t) − s₁·e^(s₂t))/(s₂ − s₁) with s₁,₂ = −ζωₙ ± ωₙ√(ζ²−1).
    static func spring(_ tSec: Double, stiffness: Double, damping: Double) -> Double {
        if tSec <= 0 { return 0 }
        let omega = stiffness.squareRoot()
        let zeta = damping / (2 * omega)
        if zeta < 1 {
            let damped = omega * (1 - zeta * zeta).squareRoot()
            return 1 - exp(-zeta * omega * tSec)
                * (cos(damped * tSec) + (zeta * omega / damped) * sin(damped * tSec))
        }
        if zeta == 1 { return 1 - exp(-omega * tSec) * (1 + omega * tSec) }
        let root = omega * (zeta * zeta - 1).squareRoot()
        let s1 = -zeta * omega + root
        let s2 = -zeta * omega - root
        return 1 - (s2 * exp(s1 * tSec) - s1 * exp(s2 * tSec)) / (s2 - s1)
    }

    /// THE SETTLE LAW: a spring clip ignores `duration` — it completes at the pinned
    /// time its envelope decays to 0.1%: T = ln(1000) / (ωₙ·(ζ − √(max(0, ζ²−1)))). At
    /// and past T the progress clamps to exactly 1, so ending never snaps.
    static func settleSeconds(stiffness: Double, damping: Double) -> Double {
        let omega = stiffness.squareRoot()
        let zeta = damping / (2 * omega)
        return log(1000.0) / (omega * (zeta - max(0, zeta * zeta - 1).squareRoot()))
    }

    /// a clip's length in ms: the authored duration, except spring which owns its clock
    static func clipMs(_ easing: SceneEasing, _ durationMs: Double) -> Double {
        if case .spring(let stiffness, let damping) = easing {
            return settleSeconds(stiffness: stiffness, damping: damping) * 1000
        }
        return durationMs
    }

    /// progress at elapsed CLIP time (ms; the caller has already removed delay + loop
    /// arithmetic). linear/bezier normalize by the clip; spring runs on real seconds
    /// and clamps to 1 at/after settle.
    static func easingProgress(_ easing: SceneEasing, _ elapsedMs: Double, _ durationMs: Double) -> Double {
        switch easing {
        case .spring(let stiffness, let damping):
            let settle = settleSeconds(stiffness: stiffness, damping: damping)
            if elapsedMs / 1000 >= settle { return 1 }
            return spring(elapsedMs / 1000, stiffness: stiffness, damping: damping)
        case .linear:
            return durationMs <= 0 ? 1 : min(max(elapsedMs / durationMs, 0), 1)
        case .bezier(let x1, let y1, let x2, let y2):
            let u = durationMs <= 0 ? 1 : min(max(elapsedMs / durationMs, 0), 1)
            return bezier(u, x1, y1, x2, y2)
        }
    }

    // ── the value plane (componentwise; colors in LINEAR RGB) ────────────────────────

    static func components(_ target: String) -> Int {
        target == "intensity" || target == "fov" ? 1 : 3
    }

    /// sRGB channel (0..1) → linear (the IEC 61966-2-1 curve)
    static func srgbToLinear(_ c: Double) -> Double {
        c <= 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4)
    }

    /// linear channel → sRGB (0..1)
    static func linearToSrgb(_ c: Double) -> Double {
        let clamped = min(max(c, 0), 1)
        return clamped <= 0.0031308 ? clamped * 12.92 : 1.055 * pow(clamped, 1 / 2.4) - 0.055
    }

    /// an authored value string → the animation VALUE PLANE: vec3 targets parse the
    /// space-separated triple; scalars one number; `color` parses #hex and LINEARIZES
    /// each channel (interpolation is plain componentwise lerp on this plane for every
    /// target). nil = malformed (the caller diags + treats the animation as inert).
    static func parseAnimValue(_ target: String, _ raw: String) -> [Double]? {
        if target == "color" {
            guard let srgb = SceneIRKit.parseSceneColor(raw) else { return nil }
            return srgb.map(srgbToLinear)
        }
        let parts = raw.split(whereSeparator: { $0.isWhitespace })
        guard parts.count == components(target) else { return nil }
        var numbers: [Double] = []
        for part in parts {
            guard let value = Double(part), value.isFinite else { return nil }
            numbers.append(value)
        }
        return numbers
    }

    /// the value plane → the RESOLVED-ATTRIBUTE string a renderer's resolver overrides
    /// with: vec3/scalar as space-separated numbers (the JS String spelling); color
    /// delinearizes to #rrggbb (displays are 8-bit — the corpus pins the linear plane,
    /// the hex is the last-step quantization).
    static func formatAnimValue(_ target: String, _ value: [Double]) -> String {
        if target == "color" {
            let hex = value.map { c -> String in
                let byte = min(255, max(0, Int((linearToSrgb(c) * 255).rounded())))
                return String(format: "%02x", byte)
            }
            return "#" + hex.joined()
        }
        return value.map { JSE.string($0) }.joined(separator: " ")
    }

    private static func lerpComponents(_ from: [Double], _ to: [Double], _ p: Double) -> [Double] {
        to.enumerated().map { i, t in
            let f = i < from.count ? from[i] : 0
            return f + (t - f) * p
        }
    }

    // ── duration / loop words ────────────────────────────────────────────────────────

    /// `2s` · `300ms` · bare `300` (ms). nil = malformed (the TS grammar
    /// `^[0-9]*\.?[0-9]+(ms|s)?$` — no sign, no exponent, must end on a digit).
    static func parseDuration(_ raw: String) -> Double? {
        var text = raw.trimmingCharacters(in: .whitespaces)
        var scale = 1.0
        if text.hasSuffix("ms") { text = String(text.dropLast(2)) }
        else if text.hasSuffix("s") { text = String(text.dropLast(1)); scale = 1000 }
        guard !text.isEmpty, text.last != ".",
              text.allSatisfy({ ($0.isASCII && $0.isNumber) || $0 == "." }),
              text.filter({ $0 == "." }).count <= 1,
              let value = Double(text), value.isFinite, value >= 0 else { return nil }
        return value * scale
    }

    /// absent/`false` → none · `true` → infinite · positive integer N → count ·
    /// `pingpong` → infinite ping-pong. Malformed → none + one diagnostic.
    static func parseLoop(_ raw: String?, _ diag: ((SceneDiagnostic) -> Void)? = nil) -> SceneLoop {
        guard let raw else { return .none }
        let text = raw.trimmingCharacters(in: .whitespaces)
        if text.isEmpty || text == "false" { return .none }
        if text == "true" { return .infinite }
        if text == "pingpong" { return .pingpong }
        if text.allSatisfy({ $0.isASCII && $0.isNumber }), let count = Int(text), count > 0 {
            return .count(count)
        }
        diag?(SceneDiagnostic(code: "malformed-animation",
                              message: "loop=\"\(raw)\" is not false, true, a positive integer or pingpong — not looping"))
        return .none
    }

    // ── explicit tweens (`<animate>`) ────────────────────────────────────────────────

    static let tweenDefaultDurationMs = 300.0

    /// parse an `<animate>` node's resolved attributes into the spec. A missing/unknown
    /// target or a malformed `to` makes the animation INERT (nil + one diagnostic) —
    /// failure is a value, the scene keeps rendering (Article 7).
    static func parseTween(_ node: SceneNode, _ resolve: SceneResolve,
                           _ diag: ((SceneDiagnostic) -> Void)? = nil) -> SceneTweenSpec? {
        func read(_ name: String) -> String? {
            guard let raw = node.attrs[name] else { return nil }
            return resolve(node, name, raw)
        }
        let target = read("target") ?? ""
        guard animTargets.contains(target) else {
            diag?(SceneDiagnostic(code: "malformed-animation",
                                  message: "<animate target=\"\(target)\"> is not one of position·rotation·scale·color·intensity·fov — inert"))
            return nil
        }
        let toRaw = read("to")
        guard let toText = toRaw, let to = parseAnimValue(target, toText) else {
            diag?(SceneDiagnostic(code: "malformed-animation",
                                  message: "<animate to=\"\(toRaw ?? "")\"> is not a \(target) value — inert"))
            return nil
        }
        var from: [Double]? = nil
        if let fromRaw = read("from") {
            from = parseAnimValue(target, fromRaw)
            if from == nil {
                diag?(SceneDiagnostic(code: "malformed-animation",
                                      message: "<animate from=\"\(fromRaw)\"> is not a \(target) value — using the base value at start"))
            }
        }
        var durationMs = tweenDefaultDurationMs
        if let durationRaw = read("duration") {
            if let parsed = parseDuration(durationRaw) { durationMs = parsed }
            else {
                diag?(SceneDiagnostic(code: "malformed-animation",
                                      message: "duration=\"\(durationRaw)\" is not ms|s — using 300ms"))
            }
        }
        var delayMs = 0.0
        if let delayRaw = read("delay") {
            if let parsed = parseDuration(delayRaw) { delayMs = parsed }
            else {
                diag?(SceneDiagnostic(code: "malformed-animation",
                                      message: "delay=\"\(delayRaw)\" is not ms|s — using 0"))
            }
        }
        let fillRaw = read("fill")
        let fill = fillRaw == "hold" ? "hold" : "none"
        if let fillRaw, fillRaw != "hold", fillRaw != "none" {
            diag?(SceneDiagnostic(code: "malformed-animation",
                                  message: "fill=\"\(fillRaw)\" is not none or hold — using none"))
        }
        return SceneTweenSpec(target: target, from: from, to: to, durationMs: durationMs,
                              delayMs: delayMs, easing: parseEasing(read("easing") ?? "", diag),
                              loop: parseLoop(read("loop"), diag), fill: fill)
    }

    /// THE VALUE LAW, pure: sample a tween at t ms since clip start. `from` is the
    /// captured start value (spec.from, or base at start when unauthored); `base` is
    /// the property's current resolved base value.
    /// - t < delay → base, not overriding (the delay shows base; delay applies ONCE).
    /// - looping: cycle c = floor((t−delay)/clip), u = (t−delay) − c·clip. pingpong
    ///   samples the easing at (clip − u) on odd cycles (the same curve, traversed
    ///   backwards). At an exact wrap instant u = 0 (the new cycle's start).
    /// - completion (loop none at clip end; loop N at N·clip): fill="hold" keeps the
    ///   final value (= to) and stays overriding; fill="none" returns to base.
    ///   done = true.
    /// - the clip length is `duration` for linear/bezier and the SETTLE TIME for spring.
    static func tweenValue(_ spec: SceneTweenSpec, from: [Double], base: [Double],
                           tMs: Double) -> SceneTweenSample {
        if tMs < spec.delayMs { return SceneTweenSample(value: base, overriding: false, done: false) }
        let clip = clipMs(spec.easing, spec.durationMs)
        let elapsed = tMs - spec.delayMs
        var finished = false
        switch spec.loop {
        case .none: finished = clip <= 0 || elapsed >= clip
        case .count(let count): finished = clip <= 0 || elapsed >= Double(count) * clip
        case .infinite, .pingpong: break
        }
        if finished {
            return spec.fill == "hold"
                ? SceneTweenSample(value: spec.to, overriding: true, done: true)
                : SceneTweenSample(value: base, overriding: false, done: true)
        }
        var cycleMs = elapsed
        var reversed = false
        if clip > 0 {
            switch spec.loop {
            case .none: break
            case .infinite, .count, .pingpong:
                let cycle = (elapsed / clip).rounded(.down)
                cycleMs = elapsed - cycle * clip
                if case .pingpong = spec.loop {
                    reversed = cycle.truncatingRemainder(dividingBy: 2) == 1
                }
            }
        }
        let p = easingProgress(spec.easing, reversed ? clip - cycleMs : cycleMs, spec.durationMs)
        return SceneTweenSample(value: lerpComponents(from, spec.to, p), overriding: true, done: false)
    }

    // ── implicit transitions ─────────────────────────────────────────────────────────

    /// split on top-level commas only — a comma inside `spring(100,10)` belongs to the
    /// easing, not the entry list
    private static func splitTransitionEntries(_ raw: String) -> [String] {
        var out: [String] = []
        var depth = 0
        var current = ""
        for ch in raw {
            if ch == "(" { depth += 1 }
            else if ch == ")" { depth = max(0, depth - 1) }
            else if ch == ",", depth == 0 { out.append(current); current = ""; continue }
            current.append(ch)
        }
        out.append(current)
        return out
    }

    /// `transition="position 300ms ease-out, color 200ms"` — comma-separated entries of
    /// `<property> <duration> [<easing>] [<delay>]` (commas inside `spring(…)` stay
    /// with the easing). A malformed entry is skipped with one diagnostic; the rest
    /// still apply.
    static func parseTransitions(_ raw: String,
                                 _ diag: ((SceneDiagnostic) -> Void)? = nil) -> [SceneTransitionEntry] {
        var out: [SceneTransitionEntry] = []
        for entry in splitTransitionEntries(raw) {
            let text = entry.trimmingCharacters(in: .whitespaces)
            if text.isEmpty { continue }
            let words = text.split(whereSeparator: { $0.isWhitespace }).map(String.init)
            let property = words.first ?? ""
            let durationMs = words.count > 1 ? parseDuration(words[1]) : nil
            guard animTargets.contains(property), let durationMs else {
                diag?(SceneDiagnostic(code: "malformed-animation",
                                      message: "transition entry \"\(text)\" is not \"<property> <duration> [easing] [delay]\" — skipped"))
                continue
            }
            var easing = parseEasing("", nil)
            var delayMs = 0.0
            var bad = false
            for word in words.dropFirst(2) {
                if let asDelay = parseDuration(word) { delayMs = asDelay; continue }
                var easingBad = false
                easing = parseEasing(word) { _ in easingBad = true }
                if easingBad { bad = true; break }
            }
            if bad {
                diag?(SceneDiagnostic(code: "malformed-animation",
                                      message: "transition entry \"\(text)\" is not \"<property> <duration> [easing] [delay]\" — skipped"))
                continue
            }
            out.append(SceneTransitionEntry(property: property, durationMs: durationMs,
                                            easing: easing, delayMs: delayMs))
        }
        return out
    }

    /// THE RETARGET LAW, pure: when the base changes, the caller builds a fresh state
    /// with `from` = the CURRENT RENDERED value (mid-flight or at rest — never snap,
    /// never queue) and `to` = the new base. During the entry's delay the rendered
    /// value HOLDS `from` (already overriding); then it eases to `to`. done = the clip
    /// completed (the rendered value equals base again — the override retires).
    static func transitionValue(_ entry: SceneTransitionEntry, _ state: SceneTransitionState,
                                _ nowMs: Double) -> (value: [Double], done: Bool) {
        let t = nowMs - state.startMs
        if t < entry.delayMs { return (value: state.from, done: false) }
        let clip = clipMs(entry.easing, entry.durationMs)
        let elapsed = t - entry.delayMs
        if clip <= 0 || elapsed >= clip { return (value: state.to, done: true) }
        let p = easingProgress(entry.easing, elapsed, entry.durationMs)
        return (value: lerpComponents(state.from, state.to, p), done: false)
    }
}
