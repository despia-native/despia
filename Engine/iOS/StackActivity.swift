//
//  StackActivity.swift - the DSX grammar for a Live Activity.
//
//  A Live Activity is ONE DSX document whose presentation slots are ELEMENTS,
//  not a JSON map: the lock-screen layout and every Dynamic Island region are
//  named tags, parsed by the engine's one parser (StackXML) into the one
//  StackNode tree, and rendered by StackLive. The slot taxonomy is Apple's; the
//  language is ours.
//
//    <activity>
//      <lockscreen> …one layout… </lockscreen>   <!-- lock screen / banner -->
//      <small> … </small>                         <!-- the WATCH Smart Stack /
//           supplemental small family (watchOS 11 mirrors the phone's activity;
//           this slot is the watch-tailored card). Missing -> the lockscreen
//           content, system-scaled (fail-open, per slot, like every other). -->
//      <island>                                   <!-- Dynamic Island -->
//        <compact>
//          <leading>  … </leading>
//          <trailing> … </trailing>
//        </compact>
//        <minimal> … </minimal>
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
//  ActivityKit import - just the DSL and its primitives.
//

import Foundation

struct StackActivity {
    let root: StackNode?

    init(_ dsx: String) { self.root = StackXML.parse(dsx, platformTarget: StackPlatformAttrs.runtimeTarget) }

    /// A slotted `<activity>` document, versus a bare single layout.
    var isDocument: Bool { root?.tag == "activity" }

    /// Walk the document by tag, first matching child at each step.
    private func descend(_ path: [String]) -> StackNode? {
        var node = root
        for tag in path { node = node?.children.first { $0.tag == tag } }
        return node
    }

    /// A slot's single visual child - what StackLive renders.
    private func slot(_ path: [String]) -> StackNode? { descend(path)?.children.first }

    var lockScreen:      StackNode? { isDocument ? slot(["lockscreen"]) : root }
    var small:           StackNode? { slot(["small"]) }
    var compactLeading:  StackNode? { slot(["island", "compact", "leading"]) }
    var compactTrailing: StackNode? { slot(["island", "compact", "trailing"]) }
    var minimal:         StackNode? { slot(["island", "minimal"]) }
    var expandedLeading:  StackNode? { slot(["island", "expanded", "leading"]) }
    var expandedTrailing: StackNode? { slot(["island", "expanded", "trailing"]) }
    var expandedCenter:   StackNode? { slot(["island", "expanded", "center"]) }
    var expandedBottom:   StackNode? { slot(["island", "expanded", "bottom"]) }
}
