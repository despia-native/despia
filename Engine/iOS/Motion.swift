//
//  Motion.swift - THE UI MOTION ENGINE, Swift twin of
//  OpenSource/Web/packages/kernel/src/motion.ts and Engine/Android core Motion.kt
//  (architecture/proposals/ui-motion.md). Corpus:
//  OpenSource/Conformance/motion/{curves,spring,retarget,physics}.json, executed here by
//  ConformanceHosts.swift's `MotionConformance` on the record lane — the SAME files the
//  TS reference (per-PR) and the Kotlin twin (:core, gradle) run, so `anim="spring"` can
//  never mean three different curves again.
//
//  THE PROBLEM THIS FILE ENDS: the UI layer carried a motion VOCABULARY (`enter` ·
//  `transition` · `keep` · `anim` · `animDuration`, universal attributes on every element
//  on every renderer) with no motion ENGINE behind it — iOS resolved it through SwiftUI,
//  Android through Compose, the web through a hand-picked cubic-bezier, and nothing held
//  the three to the same curve. The SCENE layer already solved exactly this for `<scene>`
//  (SceneAnim.swift + the animation corpus); this is the UI layer's twin.
//
//  ONE SPRING, ONE BEZIER SOLVER: this file implements NEITHER. It calls
//  `SceneAnim.bezier` / `SceneAnim.spring` / `SceneAnim.settleSeconds`. A second spring
//  in this codebase would be a bug.
//
//  Foundation-only and PURE by construction — the SwiftUI edge (StackStyle.animation in
//  Stack.swift) derives its `Animation` from a `DSXMotionSpec` produced here, and never
//  names a curve constant of its own.
//

import Foundation

/// The parsed `anim=`/`animDuration=` pair. `durationMs` is the CLIP LENGTH: the authored
/// duration for a curve, the SETTLE TIME for a spring (a spring owns its clock —
/// `animDuration` set its RESPONSE, not its length).
struct DSXMotionSpec: Equatable {
    /// "spring" · "linear" · "easeIn" · "easeOut" · "easeInOut"
    let name: String
    let durationMs: Double
    // curve plane (meaningless for a spring)
    let x1: Double
    let y1: Double
    let x2: Double
    let y2: Double
    // spring plane: the AUTHORING numbers (SwiftUI .spring(response:dampingFraction:))
    let response: Double
    let dampingFraction: Double
    // spring plane: the MATH numbers (the mass-1 oscillator SceneAnim evaluates)
    let stiffness: Double
    let damping: Double

    var isSpring: Bool { name == "spring" }
    /// the curve duration in SECONDS — what SwiftUI's `.timingCurve(_:_:_:_:duration:)` wants
    var durationSeconds: Double { durationMs / 1000 }
}

/// One `malformed-motion` diagnostic per malformed word (Article 7: failure is a value —
/// the element still animates, with the default).
typealias DSXMotionDiag = (_ code: String, _ message: String) -> Void

enum DSXMotion {

    /// The SwiftUI unit beziers — identical to the CSS timing functions of the same names.
    /// `linear` is the degenerate (0,0,1,1) whose y(s) = x(s), i.e. the identity.
    static let curves: [String: [Double]] = [
        "linear": [0, 0, 1, 1],
        "easeIn": [0.42, 0, 1, 1],
        "easeOut": [0, 0, 0.58, 1],
        "easeInOut": [0.42, 0, 0.58, 1],
    ]

    /// SwiftUI's default curve duration when none is authored.
    static let defaultDurationMs: Double = 350
    /// SwiftUI `.spring(response: 0.4, dampingFraction: 0.8)` — the native `anim="spring"`.
    static let springDefaultResponse: Double = 0.4
    static let springDefaultDampingFraction: Double = 0.8

    /// THE CONVERSION — the crux of the 1:1 claim, pinned in motion/spring.json. SwiftUI's
    /// response/dampingFraction describe a mass-1 damped oscillator: ωₙ = 2π/response,
    /// stiffness = ωₙ², damping = 2·dampingFraction·ωₙ (so ζ = dampingFraction).
    static func springConstants(response: Double, dampingFraction: Double) -> (stiffness: Double, damping: Double) {
        let omega = 2 * Double.pi / response
        return (omega * omega, 2 * dampingFraction * omega)
    }

    /// A spring spec built directly from the AUTHORING plane, for the framework's own
    /// springs (the overscroll release below) — `anim="spring"` can only ever reach damping
    /// fraction 0.8, but the kernel's physics primitives name their own.
    static func spring(response: Double, dampingFraction: Double) -> DSXMotionSpec {
        let k = springConstants(response: response, dampingFraction: dampingFraction)
        return DSXMotionSpec(
            name: "spring",
            durationMs: SceneAnim.settleSeconds(stiffness: k.stiffness, damping: k.damping) * 1000,
            x1: 0, y1: 0, x2: 1, y2: 1,
            response: response, dampingFraction: dampingFraction,
            stiffness: k.stiffness, damping: k.damping
        )
    }

    /// The `animDuration=` grammar: a plain decimal number of SECONDS, strictly > 0, on the
    /// TRIMMED string. Deliberately stricter than a bare `Double(String)` — the three
    /// runtimes must agree on what IS a duration, so the shape is one pattern all three
    /// spell the same way.
    private static func parseSeconds(_ raw: String) -> Double? {
        var digits = false
        var dot = false
        var exponent = false
        var expDigits = false
        var index = raw.startIndex
        if index < raw.endIndex, raw[index] == "+" || raw[index] == "-" { index = raw.index(after: index) }
        while index < raw.endIndex {
            let ch = raw[index]
            if ch.isASCII, ch.isNumber {
                if exponent { expDigits = true } else { digits = true }
            } else if ch == "." {
                if dot || exponent { return nil }
                dot = true
            } else if ch == "e" || ch == "E" {
                if exponent || !digits { return nil }
                exponent = true
                let next = raw.index(after: index)
                if next < raw.endIndex, raw[next] == "+" || raw[next] == "-" { index = next }
            } else {
                return nil
            }
            index = raw.index(after: index)
        }
        if !digits { return nil }
        if exponent && !expDigits { return nil }
        guard let value = Double(raw), value.isFinite, value > 0 else { return nil }
        return value
    }

    /// THE PARSE LAW. `anim` absent/empty is easeInOut and is NOT an error; any other word
    /// falls back to easeInOut with one diagnostic. `animDuration` sets the curve duration
    /// in seconds, or — for `spring` — the RESPONSE.
    static func parse(anim: String?, animDuration: String?, diag: DSXMotionDiag? = nil) -> DSXMotionSpec {
        var seconds: Double? = nil
        let rawDuration = (animDuration ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if !rawDuration.isEmpty {
            if let value = parseSeconds(rawDuration) {
                seconds = value
            } else {
                diag?("malformed-motion",
                      "animDuration=\"\(animDuration ?? "")\" is not a positive number of seconds — using the default")
            }
        }

        var name = (anim ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if name.isEmpty { name = "easeInOut" }
        if name == "spring" {
            return spring(response: seconds ?? springDefaultResponse,
                          dampingFraction: springDefaultDampingFraction)
        }
        if curves[name] == nil {
            diag?("malformed-motion",
                  "anim=\"\(anim ?? "")\" is not spring·linear·easeIn·easeOut·easeInOut — using easeInOut")
            name = "easeInOut"
        }
        let b = curves[name] ?? [0.42, 0, 0.58, 1]
        return DSXMotionSpec(
            name: name,
            durationMs: seconds.map { $0 * 1000 } ?? defaultDurationMs,
            x1: b[0], y1: b[1], x2: b[2], y2: b[3],
            response: 0, dampingFraction: 0, stiffness: 0, damping: 0
        )
    }

    /// The two motion PRESETS a renderer applies when the author sets no `anim=` on a
    /// built-in behaviour, pinned in curves.json `presets` — a renderer must not invent a
    /// third. `keep` = the `keep="true"` hide/show fade; `press` = the button press-scale
    /// snap; `default` = a bare, unauthored `anim`.
    static let presetKeep = DSXMotion.parse(anim: "easeOut", animDuration: "0.18")
    static let presetPress = DSXMotion.parse(anim: "easeOut", animDuration: "0.12")
    static let presetDefault = DSXMotion.parse(anim: nil, animDuration: nil)

    /// THE PROGRESS LAW: 0..1 at elapsed CLIP time (ms). A curve normalizes by its
    /// duration; a spring runs on the REAL clock and clamps to exactly 1 at/after settle,
    /// so ending never snaps. An underdamped spring legitimately returns > 1 mid-flight.
    static func progress(_ spec: DSXMotionSpec, elapsedMs: Double) -> Double {
        if spec.isSpring {
            if elapsedMs >= spec.durationMs { return 1 }
            if elapsedMs <= 0 { return 0 }
            return SceneAnim.spring(elapsedMs / 1000, stiffness: spec.stiffness, damping: spec.damping)
        }
        let u = spec.durationMs <= 0 ? 1 : min(max(elapsedMs / spec.durationMs, 0), 1)
        if spec.name == "linear" { return u }
        return SceneAnim.bezier(u, spec.x1, spec.y1, spec.x2, spec.y2)
    }

    /// THE SETTLE LAW: when a clip ends — the authored duration for a curve, the pinned
    /// 0.1%-envelope time for a spring (which is what `durationMs` already holds).
    static func settleMs(_ spec: DSXMotionSpec) -> Double { spec.durationMs }

    // MARK: - the retarget law (the CSS-transition interruption model, on scalars)

    /// One in-flight glide: the rendered value travels `from` → `to` starting at `startMs`.
    struct State: Equatable {
        var from: Double
        var to: Double
        var startMs: Double
    }

    static func start(from: Double, to: Double, startMs: Double) -> State {
        State(from: from, to: to, startMs: startMs)
    }

    /// The rendered value at `nowMs`, and whether the clip has completed (at/after which
    /// the value is EXACTLY `to` — the override retires without a snap).
    static func value(_ spec: DSXMotionSpec, _ state: State, nowMs: Double) -> (value: Double, done: Bool) {
        let elapsed = nowMs - state.startMs
        if spec.durationMs <= 0 || elapsed >= spec.durationMs { return (state.to, true) }
        let p = progress(spec, elapsedMs: elapsed)
        return (state.from + (state.to - state.from) * p, false)
    }

    /// THE RETARGET LAW: a new target mid-flight starts a FRESH clip from the CURRENT
    /// rendered value. Never snap to the new target, never queue behind the old clip, and
    /// no special case for retargeting to the value already being animated toward.
    static func retarget(_ spec: DSXMotionSpec, _ state: State, to: Double, nowMs: Double) -> State {
        State(from: value(spec, state, nowMs: nowMs).value, to: to, startMs: nowMs)
    }

    // MARK: - the UI physics primitives (ui-motion.md phase 2)
    //
    // Offsets and dimensions are POINTS; velocities are POINTS PER MILLISECOND. Pure folds
    // the elements call — sheet detents, pagers, pickers, pull-to-refresh and lightbox
    // dismissal all stop re-deriving their own feel.

    /// `UIScrollView.DecelerationRate.normal`, per millisecond.
    static let decelerationRate: Double = 0.998
    /// τ = −1 / ln(rate) ms — the decay time constant (≈ 499.499833 ms).
    static let decayTauMs: Double = -1 / log(0.998)
    /// Terminal velocity: at or under this a fling does not move at all (1 pt/s).
    static let decayMinVelocity: Double = 0.001
    /// The standard iOS overscroll compression constant.
    static let rubberBandC: Double = 0.55
    /// The overscroll RELEASE spring — critically damped, because a snap-back must never
    /// bounce past the edge it is returning to.
    static let rubberBandRelease = DSXMotion.spring(response: 0.35, dampingFraction: 1)

    private static func atRest(_ v0: Double) -> Bool { !(abs(v0) > decayMinVelocity) }

    /// THE DECAY LAW: x(t) = x0 + v0·τ·(1 − e^(−t/τ)).
    static func decayAt(x0: Double, v0: Double, tMs: Double) -> Double {
        if tMs <= 0 || atRest(v0) { return x0 }
        return x0 + v0 * decayTauMs * (1 - exp(-tMs / decayTauMs))
    }

    /// The resting offset — the t → ∞ limit x0 + v0·τ (x0 for a sub-threshold release).
    static func decayTarget(x0: Double, v0: Double) -> Double {
        atRest(v0) ? x0 : x0 + v0 * decayTauMs
    }

    /// How long the fling lasts: τ·ln(|v0| / threshold), 0 for a sub-threshold release —
    /// never negative.
    static func decayDurationMs(v0: Double) -> Double {
        atRest(v0) ? 0 : decayTauMs * log(abs(v0) / decayMinVelocity)
    }

    /// THE RUBBER-BAND LAW: f(x) = sign(x)·(1 − 1/(|x|·c/d + 1))·d — asymptotic, so no
    /// amount of finger travel moves the content more than `dimension` past the edge.
    static func rubberBand(_ x: Double, dimension: Double, c: Double = DSXMotion.rubberBandC) -> Double {
        if !(dimension > 0) { return 0 }
        let sign: Double = x < 0 ? -1 : 1
        let a = abs(x)
        return sign * (1 - 1 / (a * c / dimension + 1)) * dimension
    }

    /// Its exact inverse — x = (d/c)·(1/(1 − |y|/d) − 1), |y| clamped just inside d — so a
    /// gesture can resume from an already-compressed offset.
    static func rubberBandInverse(_ y: Double, dimension: Double, c: Double = DSXMotion.rubberBandC) -> Double {
        if !(dimension > 0) { return 0 }
        let sign: Double = y < 0 ? -1 : 1
        let a = min(abs(y), dimension * 0.999999)
        return sign * (dimension / c) * (1 / (1 - a / dimension) - 1)
    }

    /// THE SNAP LAW: project the release with the decay fold, then take the NEAREST snap
    /// point to that projection; an exact tie takes the LOWER point (deterministic on all
    /// three runtimes). The one law behind sheet detents, pagers and pickers.
    static func snapTarget(x0: Double, v0: Double, points: [Double]) -> (projected: Double, target: Double, index: Int) {
        let projected = decayTarget(x0: x0, v0: v0)
        if points.isEmpty { return (projected, projected, -1) }
        var bestIndex = 0
        var bestDistance = abs(points[0] - projected)
        for i in 1..<points.count {
            let distance = abs(points[i] - projected)
            if distance < bestDistance - 1e-12
                || (abs(distance - bestDistance) <= 1e-12 && points[i] < points[bestIndex]) {
                bestDistance = distance
                bestIndex = i
            }
        }
        return (projected, points[bestIndex], bestIndex)
    }
}
