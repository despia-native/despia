//
//  DesktopKeyframes.kt — the Compose Desktop frame-loop driver for `@keyframes`
//  (runtime-pressure R28). The twin of :render StackKeyframes.kt, over the SAME :core
//  MotionCore and the same corpus (OpenSource/Conformance/motion/keyframes.json); duplicated
//  here for the same reason DesktopCanvas duplicates StackCanvas — the two Compose targets do
//  not share a render module.
//
//  The battery law is the display-link law the desktop canvas already keeps: `withFrameNanos`
//  runs inside a LaunchedEffect that ends the moment the sample reports inactive, so a finite
//  animation stops its own loop at the last frame and a paused one never starts.
//
package despia.engine.desktop

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
private class DesktopMotionClock {
    var elapsed: Double = 0.0
}

/**
 * The element's attributes with this frame's animated values merged over them.
 *
 * Returns [attrs] unchanged — and installs nothing — unless the element declares an `animation`
 * whose `@keyframes` table resolves. The animated values WIN over the element's own
 * `opacity=`/`scale=`, which is CSS: a running animation overrides the base value.
 */
@Composable
internal fun desktopAnimatedAttributes(
    node: StackNode,
    attrs: Map<String, String>,
    css: CSSResolver.Context,
): Map<String, String> {
    if (attrs["animation"] == null && attrs["animationName"] == null) return attrs

    val spec = MotionCore.animationSpec(attrs)
    if (spec.none) return attrs

    val owner = attrs["css-owner"]
    val timeline = remember(owner, spec.name, css) { CSSEngine.keyframes(owner, spec.name, css) }
    if (timeline.isEmpty()) return attrs

    val clock = remember(node, spec.name, timeline) { DesktopMotionClock() }
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
