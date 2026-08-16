//
//  StackActivity.kt - the DSX grammar for a Live Activity (Kotlin twin of
//  StackActivity.swift; the Swift file is the reference implementation).
//
//  A Live Activity is ONE DSX document whose presentation slots are ELEMENTS,
//  not a JSON map: the lock-screen layout and every Dynamic Island region are
//  named tags, parsed by the engine's one parser (StackXML) into the one
//  StackNode tree, and rendered by StackLive (the Glance backend here). The
//  slot taxonomy is Apple's; the language is ours - the SAME document slices
//  the same way on every platform, and a renderer without a region for a slot
//  simply never asks for it.
//
//    <activity>
//      <lockscreen> ...one layout... </lockscreen>  <!-- lock screen / banner -->
//      <island>                                     <!-- Dynamic Island -->
//        <compact>
//          <leading>  ... </leading>
//          <trailing> ... </trailing>
//        </compact>
//        <minimal> ... </minimal>
//        <expanded>
//          <leading/> <trailing/> <center/> <bottom/>
//        </expanded>
//      </island>
//    </activity>
//
//  Each slot holds exactly ONE visual element (wrap multiples in a stack). A
//  bare layout with no <activity> root is treated as the lock screen, so a
//  plain layout string still works 1:1. A missing slot -> the caller's built-in
//  view (fail-open, per slot). Pure StackNode navigation: no new parser, no
//  ActivityKit/Glance import - just the DSL and its primitives.
//

package despia.engine

class StackActivity(dsx: String) {
    val root: StackNode? = StackXML.parse(dsx)

    /// A slotted `<activity>` document, versus a bare single layout.
    val isDocument: Boolean get() = root?.tag == "activity"

    /// Walk the document by tag, first matching child at each step.
    private fun descend(path: List<String>): StackNode? {
        var node = root
        for (tag in path) node = node?.children?.firstOrNull { it.tag == tag }
        return node
    }

    /// A slot's single visual child - what StackLive renders.
    private fun slot(path: List<String>): StackNode? = descend(path)?.children?.firstOrNull()

    val lockScreen:      StackNode? get() = if (isDocument) slot(listOf("lockscreen")) else root
    val compactLeading:  StackNode? get() = slot(listOf("island", "compact", "leading"))
    val compactTrailing: StackNode? get() = slot(listOf("island", "compact", "trailing"))
    val minimal:         StackNode? get() = slot(listOf("island", "minimal"))
    val expandedLeading:  StackNode? get() = slot(listOf("island", "expanded", "leading"))
    val expandedTrailing: StackNode? get() = slot(listOf("island", "expanded", "trailing"))
    val expandedCenter:   StackNode? get() = slot(listOf("island", "expanded", "center"))
    val expandedBottom:   StackNode? get() = slot(listOf("island", "expanded", "bottom"))
}
