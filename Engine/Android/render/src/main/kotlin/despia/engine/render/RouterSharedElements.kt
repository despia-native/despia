//
//  RouterSharedElements.kt - the Android half of U03 shared element transitions
//  (parity/U03-shared-transitions.md) and of the `lockOrientation=` router binding
//  (parity/F07-orientation.md section 3a). The DECISIONS live in the platform-neutral cores
//  (:core StackSharedTransition + StackOrientationBinding, corpora
//  OpenSource/Conformance/router/shared.json and .../input/orientation-binding.json); this file
//  is the Compose plumbing.
//
//  MEASUREMENT is the router's own coordinate space, and the FLIGHT moves the real nodes rather
//  than a snapshot. Compose's shared-element API is not in this dependency set, so the host owns
//  the placement itself: every `shared=` node reports its position through onGloballyPositioned,
//  the host asks the core which ids pair, and each end of a pair is then posed with a
//  graphicsLayer computed against its OWN measured rect - the manual lookahead placement the
//  plan specified, so the behaviour is pinned by the corpus rather than by "whatever Compose
//  does". Compose has no snapshot primitive the way UIKit does, and posing the live node is
//  better anyway: the content stays live and legible instead of becoming a bitmap.
//
//  DRIVE. Progress comes from the same Animatable the router's push/pop pose already uses, and
//  from the PREDICTIVE-BACK progress callbacks when a finger owns it - which is why an
//  interruption reverses rather than snapping: the machine is handed the progress the animation
//  had actually reached, and never restarted.
//
package despia.engine.render

import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.boundsInWindow
import androidx.compose.ui.layout.onGloballyPositioned
import despia.engine.SharedTransitionMachine
import despia.engine.StackNode
import despia.engine.StackOrientationBinding
import despia.engine.StackSharedTransition

/// Every `shared=` node the render trees have measured, keyed by frame, plus the POSE plane a
/// flight publishes. Compose state, so a flight re-composes exactly the two nodes it is moving
/// and nothing has to reach into a view to mutate it.
object SharedElementRegistry {

    private class Node(val element: StackSharedTransition.Element, val sequence: Int)

    private val nodes = HashMap<Int, LinkedHashMap<String, Node>>()
    private val counters = HashMap<Int, Int>()

    /// One end of a pair, mid-flight. `source = true` is the outgoing frame's node, false the
    /// incoming frame's; the two carry the same geometry and complementary opacities.
    class Pose(val sample: StackSharedTransition.Sample, val source: Boolean)

    /// (frame, id) to its live pose. Observable: the probe reads it during composition, so a
    /// flight re-poses the real nodes and nothing reaches into a view to mutate it.
    val poses = mutableStateMapOf<String, Pose>()

    private fun key(frame: Int, id: String): String = frame.toString() + "/" + id

    /// Record (or re-record, on re-layout) one node. Idempotent per (frame, id): a re-measure
    /// keeps the node's original document position, so a resize cannot reorder the pairs.
    @Synchronized
    fun record(
        frame: Int,
        id: String,
        rect: Rect,
        radius: Double,
        opacity: Double,
        contentMode: String,
        order: Int?,
        mode: String?,
        anim: String?,
    ) {
        if (id.isEmpty()) return
        val frameNodes = nodes.getOrPut(frame) { LinkedHashMap() }
        val position = frameNodes[id]?.sequence ?: (counters[frame] ?: 0).also { counters[frame] = it + 1 }
        frameNodes[id] = Node(
            StackSharedTransition.Element(
                id = id,
                frame = StackSharedTransition.Rect(
                    rect.left.toDouble(), rect.top.toDouble(),
                    rect.width.toDouble(), rect.height.toDouble(),
                ),
                radius = radius,
                opacity = opacity,
                contentMode = contentMode,
                // A node the layout pass has not resolved reports an empty rect. Passed through
                // honestly so the core applies the unrealised-destination rule instead of
                // animating into nothing (the collapsing-image bug).
                laid = rect.width > 0f && rect.height > 0f,
                order = order,
                mode = mode,
                anim = anim,
            ),
            position,
        )
    }

    /// This frame's shared nodes in DOCUMENT order - what the core's matcher expects.
    @Synchronized
    fun elements(frame: Int): List<StackSharedTransition.Element> =
        (nodes[frame] ?: emptyMap<String, Node>()).values.sortedBy { it.sequence }.map { it.element }

    /// The frame is permanently gone (the host's permanent-removal diff) - drop its measurements.
    @Synchronized
    fun release(frame: Int) {
        nodes.remove(frame)
        counters.remove(frame)
        val prefix = frame.toString() + "/"
        poses.keys.filter { it.startsWith(prefix) }.forEach { poses.remove(it) }
    }

    /// The node's OWN measured rect - a pose is expressed relative to it, because that is what a
    /// graphicsLayer transform is relative to.
    @Synchronized
    fun measured(frame: Int, id: String): StackSharedTransition.Rect? = nodes[frame]?.get(id)?.element?.frame

    fun pose(frame: Int, id: String): Pose? = poses[key(frame, id)]

    fun setPose(frame: Int, id: String, pose: Pose?) {
        if (pose == null) poses.remove(key(frame, id)) else poses[key(frame, id)] = pose
    }
}

/// One flight between two frames. Held by the host for exactly as long as the transition is in
/// the air, and driven either by the host's Animatable or - the acceptance test - by the finger.
class SharedFlight private constructor(
    val pairs: List<StackSharedTransition.Pair>,
    private val source: Int,
    private val destination: Int,
) {

    val machine = SharedTransitionMachine()

    companion object {
        /// null when nothing paired - the caller then runs the ordinary frame transition
        /// untouched. The unmatched law: never an error, never a flash.
        fun between(
            source: Int,
            destination: Int,
            reducedMotion: Boolean,
            frameAnim: String? = null,
        ): SharedFlight? {
            val match = StackSharedTransition.match(
                SharedElementRegistry.elements(source),
                SharedElementRegistry.elements(destination),
                reducedMotion,
                frameAnim,
            )
            if (match.pairs.isEmpty()) return null
            return SharedFlight(match.pairs, source, destination)
        }
    }

    /// Publish every pair's pose for BOTH ends. The one place the core is read during a flight.
    fun paint(progress: Double) {
        for (pair in pairs) {
            val sample = StackSharedTransition.sample(pair, progress)
            SharedElementRegistry.setPose(source, pair.id, SharedElementRegistry.Pose(sample, true))
            SharedElementRegistry.setPose(destination, pair.id, SharedElementRegistry.Pose(sample, false))
        }
    }

    fun begin(direction: StackSharedTransition.Direction) {
        paint(machine.begin(direction).progress)
    }

    fun tick(progress: Double) {
        paint(machine.tick(progress).progress)
    }

    /// A gesture takes the flight over WHERE IT IS - nothing restarts, nothing snaps.
    fun interrupt(): Double {
        val progress = machine.interrupt(machine.progress).progress
        paint(progress)
        return progress
    }

    fun drag(progress: Double) {
        paint(machine.drag(progress).progress)
    }

    fun release(commit: Boolean) {
        machine.release(commit)
    }

    /// Give the real nodes their own geometry back. Idempotent.
    fun finish() {
        for (pair in pairs) {
            SharedElementRegistry.setPose(source, pair.id, null)
            SharedElementRegistry.setPose(destination, pair.id, null)
        }
    }
}

/// The ONE modifier the render tree applies to every element (StackNodeView) - the Android twin
/// of the iOS `SharedElementProbe`. A node WITHOUT `shared=` costs one map lookup and renders
/// byte-identically; a node WITH it measures itself into the registry and, while its pair is in
/// the air, is posed from the core's interpolation schedule.
///
/// The transform is relative to the node's OWN measured rect, because that is what a
/// graphicsLayer transform is relative to. `clip` mode does not scale the content: for text that
/// changes size, stretching the glyphs is exactly the artefact the mode exists to avoid.
fun Modifier.sharedElement(frameId: Int?, attrs: Map<String, String>): Modifier {
    val id = attrs["shared"]?.trim()?.takeIf { it.isNotEmpty() } ?: return this
    if (frameId == null) return this
    // WINDOW coordinates, uniformly: both ends of a pair are measured the same way, so the
    // difference between them is all the core ever reads. No router-relative origin to thread
    // through the render tree, and nothing to get wrong when a frame is inset differently.
    val measured = Modifier.onGloballyPositioned { coordinates ->
        val bounds = coordinates.boundsInWindow()
        SharedElementRegistry.record(
            frame = frameId,
            id = id,
            rect = bounds,
            radius = attrs["radius"]?.toDoubleOrNull() ?: 0.0,
            opacity = attrs["opacity"]?.toDoubleOrNull() ?: 1.0,
            contentMode = attrs["fit"] ?: attrs["contentMode"] ?: "fill",
            order = attrs["sharedOrder"]?.toIntOrNull(),
            mode = attrs["sharedMode"],
            anim = attrs["sharedAnim"],
        )
    }
    val pose = SharedElementRegistry.pose(frameId, id) ?: return this.then(measured)
    val own = SharedElementRegistry.measured(frameId, id) ?: return this.then(measured)
    val sample = pose.sample
    val scaleX = if (!sample.scaleContent || own.width <= 0.0) 1f else (sample.width / own.width).toFloat()
    val scaleY = if (!sample.scaleContent || own.height <= 0.0) 1f else (sample.height / own.height).toFloat()
    val weight = if (pose.source) sample.sourceOpacity else sample.destinationOpacity
    return this
        .then(measured)
        .graphicsLayer {
            transformOrigin = TransformOrigin(0f, 0f)
            this.scaleX = scaleX
            this.scaleY = scaleY
            translationX = (sample.x - own.x).toFloat()
            translationY = (sample.y - own.y).toFloat()
            alpha = (sample.alpha * weight).toFloat()
        }
}

/// The `lockOrientation=` reading half - the Kotlin twin of iOS RouterOrientationBinding.
object RouterOrientationSurfaces {

    /// The `lockOrientation` a surface declares, resolved THROUGH component references: a pushed
    /// frame's root is the reference `<Name/>`, and the screen that actually declares the
    /// attribute is that template's root. Bounded at eight hops for the same reason Swift's
    /// `declaresManualSettle` is - a component cycle must cost eight lookups, not a hang.
    fun declaredLock(tag: String, scope: String?): String? {
        var node = StackNode(tag, emptyMap(), emptyList())
        var pkg = scope
        var hops = 0
        while (hops < 8) {
            val resolved = ComposeStackComponents.resolve(node.tag, pkg) ?: return null
            val template = resolved.first
            val declared = template.attrs["lockOrientation"]?.trim()
            if (!declared.isNullOrEmpty()) return declared
            node = template
            pkg = resolved.second ?: pkg
            hops += 1
        }
        return null
    }

    /// The live surfaces, bottom-of-stack first: pushed frames in stack order, then presentations
    /// in presentation order - the order the shared claim stack has to see them in, so a sheet
    /// presented over a landscape screen sits ABOVE it.
    fun surfaces(stack: List<Map<*, *>>, modal: List<Map<*, *>>): List<StackOrientationBinding.Surface> {
        val out = ArrayList<StackOrientationBinding.Surface>()
        for (entry in stack) {
            val id = RouterStackDiff.frameId(entry["id"]) ?: continue
            append(out, entry, StackOrientationBinding.frameSurface(id))
        }
        for (entry in modal) {
            val id = RouterStackDiff.frameId(entry["id"]) ?: continue
            append(out, entry, StackOrientationBinding.modalSurface(id))
        }
        return out
    }

    private fun append(out: MutableList<StackOrientationBinding.Surface>, entry: Map<*, *>, id: String) {
        val tag = (entry["component"] as? String)?.takeIf { it.isNotEmpty() }
            ?: (entry["view"] as? String)?.takeIf { it.isNotEmpty() }
            ?: return
        val to = declaredLock(tag, entry["scope"] as? String) ?: return
        out.add(StackOrientationBinding.Surface(id, to))
    }
}
