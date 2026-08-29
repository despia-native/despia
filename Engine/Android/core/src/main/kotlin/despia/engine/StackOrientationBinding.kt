//
//  StackOrientationBinding.kt - the `lockOrientation=` ROUTER BINDING core (:core, pure JVM):
//  given the surfaces the router just published and the ledger of what the router has already
//  claimed, which release/claim calls bring the shared OrientationClaimStack in line. The law is
//  the corpus: OpenSource/Conformance/input/orientation-binding.json (parity/F07-orientation.md
//  section 3a). Twin of the TS @despia/kernel orientation-binding.ts and the Swift
//  Engine/iOS/StackOrientationBinding.swift.
//
//  WHY A RECONCILE AND NOT A PAIR OF CALLBACKS. `lockOrientation` leaks precisely where a screen
//  is dismissed by a gesture instead of a button, and an appear/disappear pair has to be correct
//  five separate times (button pop, edge-swipe back, modal drag-dismiss, deep-link stack
//  replacement, a backgrounded app returning). Deriving the claims from the LIVE SET collapses
//  all five into one funnel: the router publishes its stack, this fold says what changed, and a
//  path nobody thought about produces the same plan as one everybody did. It also fixes the bug
//  the callback shape ships by construction - Compose disposes a merely COVERED screen's
//  composition, and a covered frame is still in the published stack.
//
//  The claim stack itself is StackOrientation.kt (already corpus-pinned); this file never
//  touches it.
//
package despia.engine

object StackOrientationBinding {

    /** One surface the router published that declares `lockOrientation`. */
    data class Surface(
        /** the router's claim id - `frame:<id>` for a pushed frame, `modal:<id>` for a presentation */
        val surface: String,
        /** the declared `to` word, unresolved: the module folds it against the allowed set */
        val to: String,
    )

    /** A release names only a surface; a claim carries the word to claim it with. */
    data class Op(val op: String, val surface: String, val to: String? = null)

    data class Plan(
        val ops: List<Op>,
        /** the router's ledger after the plan is applied - feed it back in on the next publish */
        val ledger: List<Surface>,
    )

    /** The claim id for a pushed route frame. One derivation on three renderers, so a frame and
     *  a presentation with the same numeric id can never collide in the shared stack. */
    fun frameSurface(frameId: Any): String = "frame:$frameId"

    /** The claim id for a presented surface (sheet, cover or overlay). */
    fun modalSurface(modalId: Any): String = "modal:$modalId"

    /**
     * Reconcile the router's orientation claims against the surfaces it just published.
     *
     * Releases are emitted BEFORE claims, so an arriving surface is never buried under a
     * departing one. A live surface whose `to` changed re-claims IN PLACE (route.updateComponent
     * can rewrite the attribute under a screen that never left) rather than release-then-claim,
     * which would send it to the top of the stack past a sheet it is already under. An unchanged
     * live set produces an EMPTY plan, which is what makes the re-assert on becomeActive
     * idempotent.
     *
     * The imperative slot (orientation.lock()/unlock()) is never named here: the router only ever
     * releases surfaces it claimed itself, so the escape hatch survives every stack change.
     */
    fun plan(live: List<Surface>, claimed: List<Surface>): Plan {
        val liveIds = live.map { it.surface }.toHashSet()
        val ops = ArrayList<Op>()

        for (entry in claimed) {
            if (entry.surface !in liveIds) ops.add(Op("release", entry.surface))
        }
        val ledger = claimed.filter { it.surface in liveIds }.map { Surface(it.surface, it.to) }.toMutableList()

        for (entry in live) {
            val index = ledger.indexOfFirst { it.surface == entry.surface }
            if (index < 0) {
                ops.add(Op("claim", entry.surface, entry.to))
                ledger.add(Surface(entry.surface, entry.to))
            } else if (ledger[index].to != entry.to) {
                ops.add(Op("claim", entry.surface, entry.to))
                ledger[index] = Surface(entry.surface, entry.to)
            }
        }
        return Plan(ops, ledger)
    }
}
