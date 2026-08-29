//
//  StackKeyframes.swift — the display-link driver for `@keyframes` (runtime-pressure R28).
//
//  The pure half lives in MotionCore, pinned by OpenSource/Conformance/motion/keyframes.json on
//  all three runtimes. This is the other half: the CADisplayLink that turns elapsed milliseconds
//  into a sampled frame, and the decomposition that hands that frame to the style ladder
//  StackStyle already runs. Twins: :render StackKeyframes.kt, :desktop DesktopKeyframes.kt.
//
//  THE BATTERY LAW, same as `<canvas on:frame>`. The link exists ONLY while an animation is
//  actually running: it is created inside a `.task(id:)` that ends the moment the sample reports
//  inactive, so a finite animation stops its own link at the last frame and a paused one never
//  starts. Task lifetime is the mount half — an element removed from the tree cancels it.
//
//  WHY IT WRITES ATTRIBUTES RATHER THAN APPLYING MODIFIERS. The sampled values re-enter the
//  element's attribute map and go through the SAME ladder as an authored `opacity=`/`scale=`,
//  which is what makes an animated element and a statically styled one render through one code
//  path. It also gets CSS's precedence for free: a running animation REPLACES the base value it
//  interpolates from rather than stacking a second modifier on top of it.
//
import Foundation
import SwiftUI
import UIKit

/// The elapsed-time source. The kernel owns the sampling law; this owns the link that feeds it.
private final class KeyframeDisplayClock {
    private var link: CADisplayLink?
    private var last: Double = 0
    private var elapsed: Double = 0
    private var sink: ((Double) -> Void)?

    func start(_ sink: @escaping (Double) -> Void) {
        guard link == nil else { return }
        self.sink = sink
        last = 0
        let created = CADisplayLink(target: self, selector: #selector(step))
        created.add(to: .main, forMode: .common)
        link = created
    }

    func stop() {
        link?.invalidate()
        link = nil
        sink = nil
    }

    @objc private func step(_ sender: CADisplayLink) {
        let now = sender.timestamp * 1000
        if last != 0 { elapsed += now - last }
        last = now
        sink?(elapsed)
    }

    deinit { stop() }
}

/// Drives one element's declared `animation` and publishes each frame's decomposed attributes
/// into the caller's state. Attaches nothing and allocates nothing when no animation is
/// declared, which is every element on a typical screen.
struct StackKeyframes: ViewModifier {
    let node: StackNode
    let declaration: [String: String]
    let isDark: Bool
    let viewport: CGSize?
    @Binding var frame: [String: String]

    /// Identity for the driving task: a change to any of these restarts the animation, which is
    /// what CSS does when the `animation` declaration itself changes.
    private var key: String {
        MotionCore.animationKeys
            .map { declaration[$0] ?? "" }
            .joined(separator: "|")
    }

    func body(content: Content) -> some View {
        content.task(id: key) {
            guard !key.isEmpty else {
                if !frame.isEmpty { frame = [:] }
                return
            }
            let spec = MotionCore.animationSpec(declaration)
            guard !spec.none else {
                if !frame.isEmpty { frame = [:] }
                return
            }
            let timeline = StackStyleSeam.keyframes(
                declaration["css-owner"], spec.name, isDark, viewport)
            guard !timeline.isEmpty else {
                if !frame.isEmpty { frame = [:] }
                return
            }

            report(spec: spec, timeline: timeline)
            frame = MotionCore.motionAttributes(
                MotionCore.sampleMotion(timeline, spec, 0).values).attributes
            guard !spec.paused else { return }

            let clock = KeyframeDisplayClock()
            defer { clock.stop() }
            // The link's callback lands on the main run loop; the stream turns it into a
            // cancellable sequence so the task's own lifetime IS the link's lifetime.
            let ticks = AsyncStream<Double> { continuation in
                clock.start { continuation.yield($0) }
                continuation.onTermination = { _ in clock.stop() }
            }
            for await elapsed in ticks {
                if Task.isCancelled { return }
                let sample = MotionCore.sampleMotion(timeline, spec, elapsed)
                frame = MotionCore.motionAttributes(sample.values).attributes
                if !sample.active { return }
            }
        }
    }

    /// Both refusals — a keyframe property outside the animatable allowlist, and a transform
    /// that cannot decompose exactly — are reported once rather than approximated. A silent
    /// approximation is the same class of defect as the silent drop R28 exists to end.
    private func report(spec: MotionCore.Spec, timeline: [MotionCore.Stop]) {
        for property in MotionCore.droppedProperties(timeline) {
            kernelLog("[DSXCSS] @keyframes \(spec.name): `\(property)` is not animatable off "
                + "the web (only opacity and transform are) — dropped rather than half-applied")
        }
        var seen = Set<String>()
        for stop in timeline {
            guard let transform = stop.declarations["transform"] else { continue }
            for fn in MotionCore.motionAttributes(["transform": transform]).unsupported
            where seen.insert(fn).inserted {
                kernelLog("[DSXCSS] @keyframes \(spec.name): transform `\(fn)` has no exact "
                    + "native decomposition — the whole transform is inert rather than approximated")
            }
        }
    }
}
