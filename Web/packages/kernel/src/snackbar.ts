/**
 * snackbar.ts — the snackbar contract, TS twin.
 *
 * The law and the reasoning live in OpenSource/Conformance/overlays/README.md; the cases live
 * in snackbar.json and run against THIS file (packages/kernel/test/snackbar-conformance.test.ts),
 * against the Kotlin twin (:core SnackbarQueue.kt) and against the Swift twin
 * (OpenSource/Engine/iOS/SnackbarQueue.swift).
 *
 * Everything here is pure: requests and endings in, the visible card / the queue / the
 * settlements out. The surface work — presenting the card, running the timer, reading the
 * safe area, animating the swipe — belongs to Core/Toast's per-platform facet. Keeping the
 * decision separate from the plumbing is what lets one corpus judge three runtimes.
 */

/** How a snackbar ended. This is what `toast.show` resolves with. */
export type SnackbarResult = 'dismissed' | 'action' | 'timeout' | 'replaced';

export type SnackbarEdge = 'bottom' | 'top';

export interface SnackbarAction {
  label: string;
  id: string;
}

/** What a caller asked for. */
export interface SnackbarRequest {
  id: string;
  message?: string;
  action?: SnackbarAction | null;
  /** `short` (4s) · `long` (10s) · a NUMBER OF SECONDS (the unit Core/Toast ships). */
  duration?: string | number | null;
  tone?: string | null;
  icon?: string | null;
  position?: string | null;
  dismissible?: boolean | null;
  replace?: boolean | null;
}

/** A normalized card: what the presenter needs and nothing else. */
export interface SnackbarEntry {
  id: string;
  message: string;
  action: SnackbarAction | null;
  durationMs: number;
  tone: string;
  icon: string;
  position: SnackbarEdge;
  dismissible: boolean;
}

export interface SnackbarSettlement {
  id: string;
  result: SnackbarResult;
}

export interface SnackbarState {
  /** The card on screen, or null. */
  current: SnackbarEntry | null;
  /** Cards waiting, in FIFO order. Never includes `current`. */
  queue: SnackbarEntry[];
  /** Every settlement so far, in the order they happened. */
  settled: SnackbarSettlement[];
}

export type SnackbarOp =
  | ({ op: 'show' } & SnackbarRequest)
  | { op: 'elapse' }
  | { op: 'action' }
  | { op: 'dismiss' }
  | { op: 'hide'; id?: string | null };

/** Material's two words, in milliseconds. */
export const SNACKBAR_SHORT_MS = 4000;
export const SNACKBAR_LONG_MS = 10_000;
/** The duration Core/Toast has shipped since it existed, kept as the wordless default. */
export const SNACKBAR_DEFAULT_MS = 2000;
/** A toast nobody can finish reading is not a toast. */
export const SNACKBAR_MIN_MS = 1000;
/** A ceiling, so a bad number cannot pin a card to the screen forever (one day). */
export const SNACKBAR_MAX_MS = 86_400_000;
/** The inset between the card and whatever is under it. */
export const SNACKBAR_GAP = 16;
/** A top-edge card sits closer: it is a banner, not a floating capsule. */
export const SNACKBAR_TOP_GAP = 12;

/**
 * How long the card stays up, in milliseconds.
 *
 * The WORDS are Material's. A NUMBER STAYS SECONDS: that is the unit `toast.show({ duration })`
 * has always taken, and redefining it under the same key would halve or double every toast
 * already shipped. An unrecognized word falls back to the default rather than failing a build.
 *
 * The default is the shipped 2s — EXCEPT when the caller supplied an action button, where two
 * seconds is not enough time to notice an Undo and reach it, so `short` takes over.
 */
export function resolveDuration(duration: string | number | null | undefined, hasAction = false): number {
  const fallback = hasAction ? SNACKBAR_SHORT_MS : SNACKBAR_DEFAULT_MS;
  if (duration === null || duration === undefined || duration === '') return fallback;
  // A boolean bridges to a number on the native lanes; a `true` duration is nonsense, not 1ms.
  if (typeof duration === 'boolean') return fallback;
  if (typeof duration === 'number') return milliseconds(duration, fallback);
  const word = String(duration).trim().toLowerCase();
  if (word === 'short') return SNACKBAR_SHORT_MS;
  if (word === 'long') return SNACKBAR_LONG_MS;
  if (word === '') return fallback;
  const seconds = Number(word);
  if (Number.isNaN(seconds)) return fallback;
  return milliseconds(seconds, fallback);
}

/**
 * Seconds to milliseconds, total: NaN and infinity fall back, and the result is clamped into
 * `[SNACKBAR_MIN_MS, one day]` so no reported number can pin a card to the screen forever.
 */
function milliseconds(seconds: number, fallback: number): number {
  if (!Number.isFinite(seconds)) return fallback;
  const ms = Math.round(seconds * 1000);
  return Math.max(SNACKBAR_MIN_MS, Math.min(Math.max(ms, 0), SNACKBAR_MAX_MS));
}

/** The requested edge, normalized. A typo is `bottom`, never a build failure. */
export function resolveEdge(position: string | null | undefined): SnackbarEdge {
  return String(position ?? '').trim().toLowerCase() === 'top' ? 'top' : 'bottom';
}

/** A request, normalized into the card the presenter draws. */
export function normalizeRequest(req: SnackbarRequest): SnackbarEntry {
  const action =
    req.action !== null && req.action !== undefined && String(req.action.label ?? '') !== ''
      ? { label: String(req.action.label), id: String(req.action.id ?? '') }
      : null;
  return {
    id: String(req.id ?? ''),
    message: String(req.message ?? ''),
    action,
    durationMs: resolveDuration(req.duration, action !== null),
    tone: String(req.tone ?? 'default'),
    icon: String(req.icon ?? ''),
    position: resolveEdge(req.position),
    dismissible: req.dismissible === null || req.dismissible === undefined ? true : Boolean(req.dismissible),
  };
}

export function snackbarInitial(): SnackbarState {
  return { current: null, queue: [], settled: [] };
}

function settle(state: SnackbarState, entry: SnackbarEntry, result: SnackbarResult): SnackbarState {
  return { ...state, settled: [...state.settled, { id: entry.id, result }] };
}

/** The visible card ended: record it and promote the head of the queue. */
function promote(state: SnackbarState, result: SnackbarResult): SnackbarState {
  if (state.current === null) return state;
  const after = settle(state, state.current, result);
  const [next, ...rest] = after.queue;
  return { current: next ?? null, queue: rest, settled: after.settled };
}

/**
 * The whole queue, in one reducer.
 *
 * ONE AT A TIME, FIFO. Stacking snackbars is how a bottom sheet becomes unreachable, so a
 * second `show` waits its turn — unless it asks to `replace`, which settles the visible card
 * as `replaced` and takes its place. Replace is a SWAP, not a reset: the cards already waiting
 * keep waiting, because the caller asked to change what is on screen, not to cancel a backlog.
 *
 * Every card settles EXACTLY ONCE, which is what makes `show` resolvable on outcome: an
 * awaited `show` that never settles is a leaked promise, and one that settles twice is a
 * double undo.
 */
export function snackbarApply(state: SnackbarState, op: SnackbarOp): SnackbarState {
  switch (op.op) {
    case 'show': {
      const entry = normalizeRequest(op);
      // The shipped rule, kept: an empty message is a no-op, not an empty card.
      if (entry.message === '') return state;
      if (state.current === null) return { ...state, current: entry };
      if (op.replace === true) {
        const after = settle(state, state.current, 'replaced');
        return { current: entry, queue: after.queue, settled: after.settled };
      }
      return { ...state, queue: [...state.queue, entry] };
    }
    case 'elapse':
      return promote(state, 'timeout');
    case 'action':
      // A tap on a button that is not there is not an outcome.
      if (state.current === null || state.current.action === null) return state;
      return promote(state, 'action');
    case 'dismiss':
      // A swipe obeys `dismissible`; see `hide` for the API route that does not.
      if (state.current === null || !state.current.dismissible) return state;
      return promote(state, 'dismissed');
    case 'hide': {
      const id = op.id === null || op.id === undefined ? '' : String(op.id);
      if (id === '' || (state.current !== null && state.current.id === id)) {
        // `hide()` is an API call, not a gesture: it settles a non-dismissible card too.
        return state.current === null ? state : promote(state, 'dismissed');
      }
      const queued = state.queue.find((e) => e.id === id);
      if (queued === undefined) return state;
      const after = settle(state, queued, 'dismissed');
      return { current: after.current, queue: after.queue.filter((e) => e.id !== id), settled: after.settled };
    }
    default:
      return state;
  }
}

/** Cards waiting behind the visible one — what `toast.queue()` resolves. */
export function snackbarPending(state: SnackbarState): number {
  return state.queue.length;
}

export interface SnackbarChrome {
  position?: string | null;
  safeAreaTop: number;
  safeAreaBottom: number;
  /** A tab bar / bottom navigation, 0 when there is none. */
  bottomBar: number;
  /** The height a floating action button occupies above the bar, 0 when there is none. */
  fab: number;
  /** What the soft keyboard covers of the layout viewport. */
  keyboard: number;
}

export interface SnackbarLift {
  edge: SnackbarEdge;
  /** Points from that edge to the near side of the card. */
  inset: number;
  /** The invariant, reported rather than assumed. */
  clearsHomeIndicator: boolean;
}

function positive(n: number): number {
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Where the card sits.
 *
 * The keyboard, when it is up, IS the obstruction: it already covers the bottom bar, the FAB
 * and the safe area, so adding them would push the card into the middle of the screen.
 * Otherwise the obstruction is the safe area plus the bar plus whatever the FAB occupies
 * above it. The 16pt gap goes on top of whichever won.
 *
 * THE INVARIANT: the bottom inset is never less than the safe-area inset plus the gap, so no
 * geometry a platform reports — including nonsense from a rotation race — can put the card on
 * the home indicator.
 */
export function resolveLift(chrome: SnackbarChrome): SnackbarLift {
  const edge = resolveEdge(chrome.position);
  const safeTop = positive(chrome.safeAreaTop);
  const safeBottom = positive(chrome.safeAreaBottom);
  if (edge === 'top') {
    return { edge, inset: safeTop + SNACKBAR_TOP_GAP, clearsHomeIndicator: true };
  }
  const keyboard = positive(chrome.keyboard);
  const chromeStack = safeBottom + positive(chrome.bottomBar) + positive(chrome.fab);
  const obstruction = keyboard > 0 ? Math.max(keyboard, safeBottom) : chromeStack;
  const inset = obstruction + SNACKBAR_GAP;
  return { edge, inset, clearsHomeIndicator: inset >= safeBottom + SNACKBAR_GAP };
}
