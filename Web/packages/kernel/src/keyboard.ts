/**
 * keyboard.ts — the soft-keyboard viewport contract, TS twin.
 *
 * The law and the reasoning live in OpenSource/Conformance/keyboard/README.md; the cases live
 * in viewport.json and run against THIS file (packages/kernel/test/keyboard.test.ts), against
 * the Kotlin twin (:core KeyboardViewportConformanceTest) and against the Swift twin.
 *
 * Everything here is pure: geometry in, published values out. The surface work — observing the
 * keyboard, resizing the web view, writing the CSS property — belongs to each platform's
 * Core/Basics/Viewport facet. Keeping the decision separate from the plumbing is what lets one
 * corpus judge three runtimes.
 */

/** How the soft keyboard is allowed to affect the layout viewport. */
export type KeyboardMode = 'legacy' | 'resize' | 'overlay';

export type KeyboardPlatform = 'ios' | 'android' | 'web';

export interface KeyboardGeometry {
  /** Is the keyboard on screen at all? */
  visible: boolean;
  /** Its height in CSS pixels. Nonsense values are treated as dismissed, never as a negative. */
  height: number;
}

export interface ViewportGeometry {
  width: number;
  height: number;
}

export interface KeyboardRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface KeyboardViewportState {
  /** The mode actually in force, after capability gating. */
  mode: KeyboardMode;
  /** True when the declared mode could not be honoured and fell back to `legacy`. */
  degraded: boolean;
  /** How much of the LAYOUT VIEWPORT the keyboard still obscures — `--keyboard-inset-height`. */
  insetHeight: number;
  /** The same fact as a boolean: `navigator.virtualKeyboard.overlaysContent`. */
  overlaysContent: boolean;
  /** Where the keyboard is, clamped to the viewport: `navigator.virtualKeyboard.boundingRect`. */
  boundingRect: KeyboardRect;
}

const EMPTY_RECT: KeyboardRect = { x: 0, y: 0, width: 0, height: 0 };

/**
 * The declared mode word, normalized. Anything unrecognized is `legacy`: this value comes from
 * a dashboard field, and a typo must not fail a build or produce half-applied behavior.
 */
export function parseKeyboardMode(declared: string | null | undefined): KeyboardMode {
  const word = String(declared ?? '').trim().toLowerCase();
  return word === 'resize' || word === 'overlay' ? word : 'legacy';
}

/**
 * The mode a runtime `navigator.virtualKeyboard.overlaysContent` assignment asks for.
 *
 * The page has exactly two things to say — overlay the content, or take the space out of the
 * layout viewport — so the standard boolean covers the whole runtime vocabulary. `legacy` is
 * deliberately unreachable from here: it is the frozen BUILD default, not something a page can
 * ask to return to.
 */
export function modeForOverlaysContent(requested: boolean): KeyboardMode {
  return requested ? 'overlay' : 'resize';
}

/**
 * Can this platform honour a non-legacy mode?
 *
 * Android only has reliable IME geometry from API 30 (`WindowInsets.Type.ime`); below that the
 * signal is inconsistent enough that a half-working `resize` is worse than none. iOS and web
 * are always capable — iOS publishes keyboard frames directly, and on the web the browser owns
 * the visual viewport already.
 */
export function supportsViewportModes(platform: KeyboardPlatform, api?: number | null): boolean {
  if (platform !== 'android') return true;
  return typeof api === 'number' && api >= 30;
}

/**
 * The whole contract, in one function.
 *
 * The subtle part is `insetHeight`, and it is the reason a page can be written once and work in
 * every mode: it reports what the keyboard obscures OF THE LAYOUT VIEWPORT, not how tall the
 * keyboard is. Under `resize` the viewport has already shrunk, so the answer is 0 — publishing
 * the raw height there would double-count and push content off screen. `boundingRect` answers
 * the different question of WHERE the keyboard is, so it stays real in every mode.
 *
 * TWO PLANES FEED ONE ANSWER. `declared` is the build's word and never moves; `requested` is the
 * page's live `overlaysContent` assignment and wins while it is set. Capability gating applies to
 * whichever won, which is why `overlaysContent` in the result is the READ-BACK CONTRACT rather
 * than an echo: a request the platform cannot honour degrades, and the page must be told what is
 * in force instead of being left believing it got what it asked for.
 */
export function resolveKeyboardViewport(input: {
  declared: string | null | undefined;
  /**
   * A live `navigator.virtualKeyboard.overlaysContent` assignment, or null/undefined when the
   * page has not asked. A page that states what it wants outranks the build's word for the rest
   * of the session: the declared mode is a default, not a ceiling.
   */
  requested?: boolean | null;
  platform: KeyboardPlatform;
  api?: number | null;
  keyboard: KeyboardGeometry;
  viewport: ViewportGeometry;
}): KeyboardViewportState {
  const declaredMode =
    typeof input.requested === 'boolean'
      ? modeForOverlaysContent(input.requested)
      : parseKeyboardMode(input.declared);
  const capable = supportsViewportModes(input.platform, input.api);
  const mode: KeyboardMode = declaredMode === 'legacy' || capable ? declaredMode : 'legacy';
  // Declaring `legacy` on an incapable platform is not degradation — it got what it asked for.
  const degraded = declaredMode !== 'legacy' && !capable;

  // A keyboard cannot obscure more than the viewport, and a negative height is nonsense that
  // reads as dismissed. Both guards matter: without them a rotation race or a bad platform
  // report becomes a negative CSS length or a rect taller than the screen.
  const rawHeight = Number.isFinite(input.keyboard.height) ? input.keyboard.height : 0;
  const height = input.keyboard.visible ? Math.max(0, Math.min(rawHeight, input.viewport.height)) : 0;

  const boundingRect: KeyboardRect =
    height > 0
      ? { x: 0, y: input.viewport.height - height, width: input.viewport.width, height }
      : { ...EMPTY_RECT };

  const overlays = mode !== 'resize';
  return {
    mode,
    degraded,
    insetHeight: overlays ? height : 0,
    overlaysContent: overlays,
    boundingRect,
  };
}
