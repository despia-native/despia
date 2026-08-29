//
//  orientation-binding.ts — the `lockOrientation=` ROUTER BINDING core: given the surfaces the
//  router just published and the ledger of what the router has already claimed, which
//  release/claim calls bring the shared OrientationClaimStack in line. The law is the corpus,
//  OpenSource/Conformance/input/orientation-binding.json (parity/F07-orientation.md §3a); the
//  Kotlin twin is :core StackOrientationBinding.kt and the Swift twin is
//  Engine/iOS/StackOrientationBinding.swift.
//
//  WHY A RECONCILE AND NOT A PAIR OF CALLBACKS. `lockOrientation` leaks precisely where a screen
//  is dismissed by a gesture instead of a button, and an appear/disappear pair has to be correct
//  five separate times (button pop · edge-swipe back · modal drag-dismiss · deep-link stack
//  replacement · a backgrounded app returning). Deriving the claims from the LIVE SET collapses
//  all five into one funnel: the router publishes its stack, this fold says what changed, and a
//  path nobody thought about produces the same plan as one everybody did. It also fixes the bug
//  the callback shape ships by construction — SwiftUI and Compose both report a merely COVERED
//  screen as disappeared, and a covered frame is still in the published stack.
//
//  The claim stack itself is orientation.ts (already corpus-pinned); this file never touches it.
//

/** One surface the router published that declares `lockOrientation`. */
export interface OrientationSurface {
  /** the router's claim id — `frame:<id>` for a pushed frame, `modal:<id>` for a presentation */
  surface: string;
  /** the declared `to` word, unresolved: the module folds it against the app's allowed set */
  to: string;
}

export type OrientationOp =
  | { op: "release"; surface: string }
  | { op: "claim"; surface: string; to: string };

export interface OrientationPlan {
  ops: OrientationOp[];
  /** the router's ledger after the plan is applied — feed it back in on the next publish */
  ledger: OrientationSurface[];
}

/** The claim id for a pushed route frame. One derivation on three renderers, so a frame and a
 *  presentation with the same numeric id can never collide in the shared stack. */
export function orientationFrameSurface(frameId: number | string): string {
  return `frame:${frameId}`;
}

/** The claim id for a presented surface (sheet, cover or overlay). */
export function orientationModalSurface(modalId: number | string): string {
  return `modal:${modalId}`;
}

/**
 * Reconcile the router's orientation claims against the surfaces it just published.
 *
 * Releases are emitted BEFORE claims, so an arriving surface is never buried under a departing
 * one. A live surface whose `to` changed re-claims IN PLACE (`route.updateComponent` can rewrite
 * the attribute under a screen that never left) rather than release-then-claim, which would send
 * it to the top of the stack past a sheet it is already under. An unchanged live set produces an
 * EMPTY plan, which is what makes the re-assert on `becomeActive` idempotent.
 *
 * The imperative slot (`orientation.lock()` / `unlock()`) is never named here: the router only
 * ever releases surfaces it claimed itself, so the escape hatch survives every stack change.
 */
export function orientationClaimPlan(
  live: readonly OrientationSurface[],
  claimed: readonly OrientationSurface[],
): OrientationPlan {
  const liveIds = new Set(live.map((entry) => entry.surface));
  const ops: OrientationOp[] = [];

  for (const entry of claimed) {
    if (!liveIds.has(entry.surface)) ops.push({ op: "release", surface: entry.surface });
  }
  const ledger: OrientationSurface[] = claimed
    .filter((entry) => liveIds.has(entry.surface))
    .map((entry) => ({ surface: entry.surface, to: entry.to }));

  for (const entry of live) {
    const existing = ledger.find((held) => held.surface === entry.surface);
    if (existing === undefined) {
      ops.push({ op: "claim", surface: entry.surface, to: entry.to });
      ledger.push({ surface: entry.surface, to: entry.to });
    } else if (existing.to !== entry.to) {
      ops.push({ op: "claim", surface: entry.surface, to: entry.to });
      existing.to = entry.to;
    }
  }
  return { ops, ledger };
}
