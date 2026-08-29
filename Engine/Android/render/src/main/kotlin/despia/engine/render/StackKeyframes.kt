//
//  StackKeyframes.kt — the frame-loop driver for `@keyframes` (runtime-pressure R28).
//
//  The pure half lives in :core MotionCore, pinned by OpenSource/Conformance/motion/keyframes.json
//  on all three runtimes. This is the other half: the display link that turns elapsed
//  milliseconds into a sampled frame, and the decomposition that hands that frame to the style
//  ladder StackStyle already runs.
//
//  THE BATTERY LAW, same as `<canvas on:frame>`. The loop is installed ONLY while an animation
//  is actually running: `withFrameNanos` is suspended in a LaunchedEffect that ends the moment
//  the sample reports inactive, so a finite animation stops its own display link at the last
//  frame and a paused one never starts. Composition scope is the visibility half — an element
//  scrolled out of a lazy list is disposed, which cancels the effect.
//
//  WHAT IT REFUSES. `MotionCore.motionAttributes` decomposes a sampled transform into the four
//  attributes the ladder applies (opacity, rotation, uniform scale, offsetX/offsetY) or refuses
//  it whole. Both refusals — a keyframe property outside the animatable allowlist, and a
//  transform that cannot decompose exactly — are LOGGED once per element rather than
//  approximated, because a silent approximation is the same class of defect as the silent drop
//  R28 exists to end.
//
package despia.engine.render

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import despia.engine.CSSEngine
import despia.engine.CSSResolver
import despia.engine.MotionCore
import despia.engine.StackNode
import despia.engine.kernelLog

/** Elapsed milliseconds, held across a pause so `animation-play-state` resumes rather than restarts. */
private class MotionClock {
    var elapsed: Double = 0.0
}

/**
 * The element's attributes with this frame's animated values merged over them.
 *
 * Returns [attrs] unchanged — and installs nothing — unless the element declares an `animation`
 * whose `@keyframes` table actually resolves, so the cost on an unanimated element is one map
 * lookup. The animated values WIN over the element's own `opacity=`/`scale=`, which is CSS: a
 * running animation overrides the base value it interpolates from.
 */
@Composable
internal fun animatedAttrs(
    node: StackNode,
    attrs: Map<String, String>,
    css: CSSResolver.Context?,
): Map<String, String> {
    if (css == null) return attrs
    if (attrs["animation"] == null && attrs["animationName"] == null) return attrs

    val spec = MotionCore.animationSpec(attrs)
    if (spec.none) return attrs

    val owner = attrs["css-owner"]
    val timeline = remember(owner, spec.name, css) { CSSEngine.keyframes(owner, spec.name, css) }
    if (timeline.isEmpty()) return attrs

    val clock = remember(node, spec.name, timeline) { MotionClock() }
    var sample by remember(node, spec.name, timeline) {
        mutableStateOf(MotionCore.sampleMotion(timeline, spec, clock.elapsed))
    }

    LaunchedEffect(node, spec, timeline) {
        if (spec.paused) return@LaunchedEffect
        var last = 0L
        var running = true
        while (running) {
            withFrameNanos { nanos ->
                if (last != 0L) clock.elapsed += (nanos - last) / 1_000_000.0
                last = nanos
                val next = MotionCore.sampleMotion(timeline, spec, clock.elapsed)
                sample = next
                running = next.active
            }
        }
    }

    val decomposed = MotionCore.motionAttributes(sample.values)
    remember(node, spec.name, timeline) {
        for (property in sample.dropped) {
            kernelLog(
                "[DSXCSS] @keyframes ${spec.name}: `$property` is not animatable off the web " +
                    "(only opacity and transform are) — dropped rather than half-applied",
            )
        }
        for (fn in decomposed.unsupported) {
            kernelLog(
                "[DSXCSS] @keyframes ${spec.name}: transform `$fn` has no exact native " +
                    "decomposition — the whole transform is inert rather than approximated",
            )
        }
        true
    }

    if (decomposed.attributes.isEmpty()) return attrs
    return attrs + decomposed.attributes
}
