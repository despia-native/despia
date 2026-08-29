//
//  orientation.ts — the shared `lockOrientation=` / orientation-module core: the vocabulary
//  fold + the claim stack. The law is the corpus,
//  OpenSource/Conformance/input/orientation.json (parity/F07-orientation.md); the Kotlin twin
//  is :core StackOrientation.kt and the Swift twin is Engine/iOS/StackOrientation.swift.
//
//  Everything platform-shaped lives OUTSIDE this file. The Orientation module applies a
//  resolved mask through screen.orientation.lock() (web), Activity.requestedOrientation
//  (Android) or UIWindowScene.requestGeometryUpdate (iOS), and the router drives claim/release
//  off surface appear/disappear. Keeping the DECISION separate from the PLUMBING is what lets
//  one corpus judge three renderers.
//

/** The canonical order every resolved mask is emitted in, regardless of the order the app
 *  declared its supported orientations. A stable order is what makes `primary` stable. */
export const ORIENTATION_CANONICAL: readonly string[] = [
  "portrait", "portraitUpsideDown", "landscapeLeft", "landscapeRight",
];

/** A resolved lock: the full mask the platform is asked to allow, and the orientation the
 *  device rotates TO (the first surviving entry in canonical order). */
export interface OrientationResolved {
  readonly mask: readonly string[];
  readonly primary: string;
}

/** Why a fold refused. Both are LOUD — a lock that silently no-ops is the hardest orientation
 *  bug there is, and it is exactly what the third-party libraries do. */
export type OrientationRefusal = "unknown_orientation" | "not_allowed";

/** The fold's result: a resolved lock, or the stable machine id the caller reports. */
export type OrientationResolution =
  | { readonly ok: true; readonly value: OrientationResolved }
  | { readonly ok: false; readonly error: OrientationRefusal };

/**
 * Fold one `to` word against the app's build-time allowed set.
 *
 * `to` is exact-case after trimming — `Portrait` is not `portrait`, because a case-insensitive
 * vocabulary is a vocabulary nobody can lint. `landscape` expands to both landscape
 * orientations, `all` to the whole allowed set, `current` to the live orientation. The
 * expansion is intersected with `allowed` in canonical order; an empty intersection is
 * `not_allowed` rather than a silent no-op.
 */
export function resolveOrientation(
  to: string | null | undefined,
  allowed: readonly string[],
  current?: string | null,
): OrientationResolution {
  const word = (to ?? "").trim();
  let expanded: readonly string[];
  if (word === "") return { ok: false, error: "unknown_orientation" };
  else if (word === "all") expanded = ORIENTATION_CANONICAL;
  else if (word === "landscape") expanded = ["landscapeLeft", "landscapeRight"];
  else if (word === "current") {
    const live = (current ?? "").trim();
    expanded = ORIENTATION_CANONICAL.includes(live) ? [live] : [];
  } else if (ORIENTATION_CANONICAL.includes(word)) expanded = [word];
  else return { ok: false, error: "unknown_orientation" };

  const permitted = new Set(
    allowed.map((entry) => String(entry ?? "").trim()).filter((entry) => ORIENTATION_CANONICAL.includes(entry)),
  );
  const mask = ORIENTATION_CANONICAL.filter((entry) => expanded.includes(entry) && permitted.has(entry));
  if (mask.length === 0) return { ok: false, error: "not_allowed" };
  return { ok: true, value: { mask, primary: mask[0]! } };
}

/** The imperative `orientation.unlock()` slot, so the module and the attribute share one stack. */
export const ORIENTATION_IMPERATIVE_ID = "imperative";

/**
 * The claim stack — the actual feature behind `lockOrientation=`.
 *
 * A surface claims on appear and releases on disappear, so every dismissal path (button pop,
 * edge-swipe back, modal drag-dismiss, deep-link stack replacement, a backgrounded app
 * returning) reverts through ONE funnel instead of each screen remembering to undo itself.
 *
 * The effective lock is the LAST live entry, or null for the app default. A re-claim by a live
 * id replaces in place, so a screen re-declaring can never jump above a sheet it presented.
 * Releasing a mid-stack entry leaves the top standing.
 */
export class OrientationClaimStack {
  #claims: { id: string; to: string }[] = [];

  /** The `to` word currently in force, or null when nothing is claimed. */
  get effective(): string | null {
    return this.#claims.length === 0 ? null : this.#claims[this.#claims.length - 1]!.to;
  }

  /** Claim (or re-claim, in place) for `id`. Returns the new `effective`. */
  claim(id: string, to: string): string | null {
    const existing = this.#claims.find((entry) => entry.id === id);
    if (existing) existing.to = to;
    else this.#claims.push({ id, to });
    return this.effective;
  }

  /** Release `id`. Unknown ids are a no-op — a surface may release without ever claiming. */
  release(id: string): string | null {
    this.#claims = this.#claims.filter((entry) => entry.id !== id);
    return this.effective;
  }

  /** Drop every claim — the deep-link-replaces-the-stack path. */
  reset(): string | null {
    this.#claims = [];
    return this.effective;
  }
}
