//
//  StackDensity.kt - the shared density= grammar (:core, pure JVM): the attribute fold
//  and the subtree resolution. The law is the corpus:
//  OpenSource/Conformance/input/density.json (component-library.md W9 - the universal
//  subtree density knob). The twin of Swift StackDensity (StackNode.swift) and the web
//  @despia/dom resolveDensity/effectiveDensity (mount.ts). The vocabulary is exactly
//  `comfortable | compact`, exact lowercase after trim; anything else is NO pin, so an
//  element stays transparent to its ancestors' density. effective() walks the authored
//  chain nearest-first - an invalid nearer value never masks an outer pin - and with no
//  pin the PLATFORM default applies: compact on a desktop fine-pointer surface,
//  comfortable everywhere else (the adapter owns finePointer detection).
//
//  RENDER half (:render), landed (W12 red sweep): Compose M3 ships no control-density
//  system (no controlSize analogue), so the presentation mapping rides the platform's
//  own size knob instead — the dispatch funnel (StackNodeView.kt NodeContent density
//  arm) resolves an authored density= through this object and pins the subtree's
//  LocalMinimumInteractiveComponentSize (compact 40dp / comfortable 48dp); M3 controls
//  and the `minimumInteractiveComponentSize()`-floored DSX metrics re-derive their
//  targets from it, the Stack.swift ~6037 `.environment(\.controlSize)` twin. The
//  RESOLUTION stays corpus-gated here so grammar cannot drift.
//
package despia.engine

object StackDensity {

    const val COMFORTABLE = "comfortable"
    const val COMPACT = "compact"

    /** Resolve density=: exact lowercase vocabulary after trim; anything else is no pin. */
    fun resolve(density: String?): String? {
        val trimmed = density?.trim() ?: return null
        return if (trimmed == COMFORTABLE || trimmed == COMPACT) trimmed else null
    }

    /** The subtree law (density.json effective[]): `chain` is the authored raw density
     *  attributes from the root to the element (null = not authored); the NEAREST
     *  resolving pin wins, else the platform default (compact iff finePointer). */
    fun effective(chain: List<String?>, finePointer: Boolean): String {
        for (index in chain.indices.reversed()) {
            resolve(chain[index])?.let { return it }
        }
        return if (finePointer) COMPACT else COMFORTABLE
    }
}
