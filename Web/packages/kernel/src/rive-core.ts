//
//  rive-core.ts - the shared `<rive>` core (parity/U12-rive.md): the state-machine input
//  plane, artboard/machine/animation selection, the fit and alignment fold, the playback
//  and residency lifecycle, the event payloads and the accessibility verdict. The law is
//  the corpus, OpenSource/Conformance/rive/; the Kotlin twin is :core RiveCore.kt and the
//  Swift twin is Engine/iOS/RiveCore.swift, both reading the SAME six files off disk.
//
//  WHY A SHARED CORE WHEN THE RENDERER IS ONE VENDOR LIBRARY. Rive's own runtime draws the
//  same picture on all three platforms, so pixels are the one thing that cannot diverge and
//  the one thing worth pinning nowhere. What CAN diverge is everything around the vendor
//  library: which artboard a missing name resolves to, whether a trigger fires twice on a
//  re-render, whether an offscreen animation keeps advancing, what a state change looks like
//  when it reaches an author's handler. Three hand-written adapters would answer those four
//  questions four ways. They live here instead, as data folds with no vendor type in sight.
//
//  This file imports nothing and names no Rive symbol: the RUNTIME is a ClosedSource module
//  (Core/Rive, MIT, vendored and pinned there), and the kernel keeps resolving zero package
//  coordinates. What lives here is arithmetic and vocabulary.
//

// ── numbers ──────────────────────────────────────────────────────────────────────────

/** the canonical text of a number, used as the input plane's change token. Six decimals,
 *  no negative zero, integers without a point - the same spelling CanvasCore uses, for the
 *  same reason: three languages must agree on when a value "changed". */
export function riveNumberText(value: number): string {
  if (!Number.isFinite(value)) return "0";
  const rounded = Math.round(value * 1e6) / 1e6;
  if (Object.is(rounded, -0) || rounded === 0) return "0";
  return String(rounded);
}

function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/** the ONE numeric grammar all three renderers accept in a bound input: an optional sign,
 *  decimal digits, an optional exponent. Deliberately narrower than either language's own
 *  parser - JS `Number()` reads `0x10` and Kotlin's `toDouble()` reads `1d`, and a value that
 *  means 16 on the web and nothing on Android is the exact drift this corpus exists to stop. */
const RIVE_NUMBER_GRAMMAR = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

function parseFiniteNumber(text: string): number | null {
  const trimmed = text.trim();
  if (!RIVE_NUMBER_GRAMMAR.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

// ── the state-machine input plane ────────────────────────────────────────────────────

export type RiveInputKind = "boolean" | "number" | "trigger";

export type RiveDeclaredInput = { readonly name: string; readonly type: string };

export type RiveInputOp = {
  readonly name: string;
  readonly kind: RiveInputKind;
  /** the level to write; null for a trigger, which is an edge and carries no value */
  readonly value: boolean | number | null;
};

export type RiveInputRefusal = {
  readonly name: string;
  readonly code: "unknown_input" | "input_type";
  readonly message: string;
};

export type RiveInputPlan = {
  readonly ops: RiveInputOp[];
  readonly refusals: RiveInputRefusal[];
  /** the token map to feed the NEXT fold: this is the trigger edge detector */
  readonly values: { [name: string]: string };
};

/** the tokens a trigger reads as "not fired yet" */
const RIVE_FALSY_TOKENS = new Set(["", "false", "0"]);

function booleanToken(raw: unknown): boolean | null {
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw !== 0 : null;
  if (typeof raw === "string") {
    const low = raw.trim().toLowerCase();
    if (low === "true") return true;
    if (low === "false") return false;
    const parsed = parseFiniteNumber(low);
    return parsed === null ? null : parsed !== 0;
  }
  return null;
}

function numberToken(raw: unknown): number | null {
  if (typeof raw === "boolean") return null;   // `count: true` is a shape mistake, not a 1
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw === "string") return parseFiniteNumber(raw);
  return null;
}

function triggerToken(raw: unknown): string {
  if (typeof raw === "boolean") return raw ? "true" : "false";
  if (typeof raw === "number") return riveNumberText(raw);
  return String(raw).trim();
}

/**
 * Turn a bound `inputs` object into the smallest set of writes the machine needs.
 *
 * The DECLARED list is authority (an undeclared key is refused, never guessed at), LEVELS
 * are diffed against `previous` so an unchanged re-render writes nothing, and a TRIGGER is
 * an EDGE: it fires when its token changes to a truthy one. That last rule is the whole
 * reason `inputs` can be declarative - `{ celebrate: order.justPlaced }` fires once per
 * order rather than once per frame, with no imperative call anywhere.
 *
 * A refusal never aborts the plan: one bad binding must not freeze an animation.
 */
export function riveInputPlan(
  declared: readonly RiveDeclaredInput[],
  bound: { readonly [name: string]: unknown },
  previous: { readonly [name: string]: string },
): RiveInputPlan {
  const ops: RiveInputOp[] = [];
  const refusals: RiveInputRefusal[] = [];
  const values: { [name: string]: string } = { ...previous };
  const seen = new Set<string>();

  for (const input of declared) {
    const name = input.name;
    seen.add(name);
    if (!Object.prototype.hasOwnProperty.call(bound, name)) continue;
    const raw = bound[name];
    if (raw === null || raw === undefined) continue;      // an unresolved binding is not an error
    const prev = previous[name];

    if (input.type === "boolean") {
      const flag = booleanToken(raw);
      if (flag === null) {
        refusals.push({ name, code: "input_type", message: `input '${name}' expects a boolean` });
        continue;
      }
      const token = flag ? "true" : "false";
      if (token !== prev) {
        ops.push({ name, kind: "boolean", value: flag });
        values[name] = token;
      }
      continue;
    }

    if (input.type === "number") {
      const value = numberToken(raw);
      if (value === null) {
        refusals.push({ name, code: "input_type", message: `input '${name}' expects a number` });
        continue;
      }
      const token = riveNumberText(value);
      if (token !== prev) {
        ops.push({ name, kind: "number", value: round6(value) });
        values[name] = token;
      }
      continue;
    }

    if (input.type === "trigger") {
      const token = triggerToken(raw);
      if (token !== prev && !RIVE_FALSY_TOKENS.has(token.toLowerCase())) {
        ops.push({ name, kind: "trigger", value: null });
      }
      values[name] = token;                                // the falling edge is recorded too
      continue;
    }

    refusals.push({ name, code: "input_type", message: `input '${name}' has an unknown input type` });
  }

  for (const name of Object.keys(bound).filter((key) => !seen.has(key)).sort()) {
    refusals.push({
      name,
      code: "unknown_input",
      message: `the state machine declares no input named '${name}'`,
    });
  }

  return { ops, refusals, values };
}

// ── artboard / machine / animation selection ─────────────────────────────────────────

export type RiveArtboard = {
  readonly name: string;
  readonly default?: boolean;
  readonly stateMachines?: readonly string[];
  readonly animations?: readonly string[];
};

export type RiveManifest = { readonly artboards?: readonly RiveArtboard[] };

export type RiveSelectionError = { readonly code: "not_found" | "conflict"; readonly message: string };

export type RiveSelection = {
  readonly artboard: string | null;
  readonly stateMachine: string | null;
  readonly animation: string | null;
  readonly mode: "machine" | "animation" | "idle";
  readonly error: RiveSelectionError | null;
};

function attrText(attrs: { readonly [name: string]: unknown }, name: string): string {
  const raw = attrs[name];
  return raw === null || raw === undefined ? "" : String(raw).trim();
}

function refused(code: "not_found" | "conflict", message: string): RiveSelection {
  // A refusal is TOTAL: nothing half-mounts a selection it was told to reject.
  return { artboard: null, stateMachine: null, animation: null, mode: "idle", error: { code, message } };
}

/**
 * Resolve which artboard, and which machine or animation inside it, this `<rive>` plays.
 *
 * Every miss is `not_found` NAMING what was asked for and where it was looked up, because a
 * mistyped artboard rendering a blank box is the single worst failure mode this component
 * has (plan §7). `stateMachine` and `animation` together is a conflict rather than a silent
 * precedence rule - the kind of rule an author never finds when it goes the other way.
 */
export function riveSelection(
  manifest: RiveManifest,
  attrs: { readonly [name: string]: unknown },
): RiveSelection {
  const boards = manifest.artboards ?? [];
  if (boards.length === 0) return refused("not_found", "this .riv file declares no artboard");

  const wantBoard = attrText(attrs, "artboard");
  const wantMachine = attrText(attrs, "stateMachine");
  const wantAnimation = attrText(attrs, "animation");
  if (wantMachine !== "" && wantAnimation !== "") {
    return refused("conflict", "<rive> takes stateMachine or animation, not both");
  }

  let board: RiveArtboard | undefined;
  if (wantBoard !== "") {
    board = boards.find((candidate) => candidate.name === wantBoard);
    if (board === undefined) {
      return refused("not_found", `no artboard named '${wantBoard}' in this .riv file`);
    }
  } else {
    board = boards.find((candidate) => candidate.default === true) ?? boards[0];
  }

  const machines = board.stateMachines ?? [];
  const animations = board.animations ?? [];

  if (wantAnimation !== "") {
    if (!animations.includes(wantAnimation)) {
      return refused("not_found", `no animation named '${wantAnimation}' on artboard '${board.name}'`);
    }
    return { artboard: board.name, stateMachine: null, animation: wantAnimation, mode: "animation", error: null };
  }
  if (wantMachine !== "") {
    if (!machines.includes(wantMachine)) {
      return refused("not_found", `no state machine named '${wantMachine}' on artboard '${board.name}'`);
    }
    return { artboard: board.name, stateMachine: wantMachine, animation: null, mode: "machine", error: null };
  }
  if (machines.length > 0) {
    return { artboard: board.name, stateMachine: machines[0], animation: null, mode: "machine", error: null };
  }
  if (animations.length > 0) {
    return { artboard: board.name, stateMachine: null, animation: animations[0], mode: "animation", error: null };
  }
  // An artboard with neither is a static drawing. Legal, and not an error.
  return { artboard: board.name, stateMachine: null, animation: null, mode: "idle", error: null };
}

// ── fit and alignment ────────────────────────────────────────────────────────────────

export const RIVE_FIT_WORDS: { readonly [key: string]: string } = {
  cover: "cover", contain: "contain", fill: "fill",
  fitwidth: "fitWidth", fitheight: "fitHeight", none: "none",
};

export const RIVE_ALIGNMENT_WORDS: { readonly [key: string]: string } = {
  center: "center", centre: "center",
  top: "topCenter", topcenter: "topCenter", topleft: "topLeft", topright: "topRight",
  bottom: "bottomCenter", bottomcenter: "bottomCenter",
  bottomleft: "bottomLeft", bottomright: "bottomRight",
  left: "centerLeft", centerleft: "centerLeft",
  right: "centerRight", centerright: "centerRight",
};

const RIVE_ALIGNMENT_FACTORS: { readonly [word: string]: readonly [number, number] } = {
  topLeft: [0, 0], topCenter: [0.5, 0], topRight: [1, 0],
  centerLeft: [0, 0.5], center: [0.5, 0.5], centerRight: [1, 0.5],
  bottomLeft: [0, 1], bottomCenter: [0.5, 1], bottomRight: [1, 1],
};

export type RivePlacement = {
  readonly fit: string;
  readonly alignment: string;
  readonly scaleX: number;
  readonly scaleY: number;
  readonly x: number;
  readonly y: number;
  readonly diagnostics: string[];
};

/** lowercase, strip every separator, then look the word up: `Bottom-Right` is `bottomright`. */
function foldWord(
  raw: unknown, table: { readonly [key: string]: string }, fallback: string,
  diagnostics: string[], kind: string,
): string {
  if (raw === null || raw === undefined) return fallback;
  const text = String(raw).trim();
  const key = text.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (key === "") return fallback;                      // absent is not a diagnostic
  const word = table[key];
  if (word === undefined) {
    diagnostics.push(`unknown ${kind} '${text}'`);
    return fallback;
  }
  return word;
}

/**
 * Place an artboard of `content` size inside a `box`. Scale is per-fit; placement is
 * `align * (box - content * scale)`, so the same nine factors serve all six fits.
 *
 * An unknown word FOLDS to the default and is diagnosed rather than refused: a typo in a
 * presentation attribute must not blank an animation, and must not be silent either. A
 * zero-sized artboard is diagnosed and placed at scale 1, because a NaN transform is an
 * invisible animation nobody can debug.
 */
export function riveFit(
  fit: unknown, alignment: unknown,
  contentWidth: number, contentHeight: number, boxWidth: number, boxHeight: number,
): RivePlacement {
  const diagnostics: string[] = [];
  const fitWord = foldWord(fit, RIVE_FIT_WORDS, "contain", diagnostics, "fit");
  const alignWord = foldWord(alignment, RIVE_ALIGNMENT_WORDS, "center", diagnostics, "alignment");
  const [ax, ay] = RIVE_ALIGNMENT_FACTORS[alignWord] ?? [0.5, 0.5];

  const sane = Number.isFinite(contentWidth) && Number.isFinite(contentHeight)
    && Number.isFinite(boxWidth) && Number.isFinite(boxHeight)
    && contentWidth > 0 && contentHeight > 0 && boxWidth >= 0 && boxHeight >= 0;
  if (!sane) {
    diagnostics.push("the artboard has no intrinsic size");
    return {
      fit: fitWord, alignment: alignWord, scaleX: 1, scaleY: 1,
      x: round6(ax * Math.max(Number.isFinite(boxWidth) ? boxWidth : 0, 0)),
      y: round6(ay * Math.max(Number.isFinite(boxHeight) ? boxHeight : 0, 0)),
      diagnostics,
    };
  }

  let scaleX: number;
  let scaleY: number;
  switch (fitWord) {
    case "cover": scaleX = scaleY = Math.max(boxWidth / contentWidth, boxHeight / contentHeight); break;
    case "fill": scaleX = boxWidth / contentWidth; scaleY = boxHeight / contentHeight; break;
    case "fitWidth": scaleX = scaleY = boxWidth / contentWidth; break;
    case "fitHeight": scaleX = scaleY = boxHeight / contentHeight; break;
    case "none": scaleX = scaleY = 1; break;
    default: scaleX = scaleY = Math.min(boxWidth / contentWidth, boxHeight / contentHeight); break;
  }
  return {
    fit: fitWord, alignment: alignWord,
    scaleX: round6(scaleX), scaleY: round6(scaleY),
    x: round6(ax * (boxWidth - contentWidth * scaleX)),
    y: round6(ay * (boxHeight - contentHeight * scaleY)),
    diagnostics,
  };
}

// ── playback lifecycle ───────────────────────────────────────────────────────────────

export const RIVE_FRAME_MIN_INTERVAL_MS = 1000 / 60;

export type RiveAdvance = { readonly time: number; readonly delta: number; readonly frame: number };

export type RivePlaybackEvent =
  | { readonly type: "mount" }
  | { readonly type: "unmount" }
  | { readonly type: "visible"; readonly value: boolean }
  | { readonly type: "active"; readonly value: boolean }
  | { readonly type: "play" }
  | { readonly type: "pause" }
  | { readonly type: "tick"; readonly at: number };

export type RivePlaybackFold = {
  emitted: RiveAdvance[];
  starts: number;
  pauses: number;
  instantiations: number;
  disposals: number;
  drops: number;
  advancing: boolean;
  live: boolean;
};

/**
 * A Rive artboard is a live scene, not a decoded image: an offscreen one that keeps
 * advancing is a battery bug, and twenty of them retained in a list is a memory bug. The
 * machine advances only while it is LIVE (mounted), WANTED (autoplay or an explicit play),
 * ON SCREEN, and the app is FOREGROUND; a tick arriving otherwise is DROPPED, never queued,
 * so `time` is accumulated delta and excludes the offscreen interval.
 *
 * Unmount DISPOSES, and a remount is a fresh instance: the clock restarts at zero and the
 * wanted-state returns to `autoplay`, because an imperative play() belongs to the scene that
 * received it.
 */
export class RivePlayback {
  private visible = true;
  private active = true;
  private wanted: boolean;
  private liveFlag = false;
  private advancingFlag = false;
  private lastTick: number | null = null;
  private time = 0;
  private frame = 0;

  starts = 0;
  pauses = 0;
  instantiations = 0;
  disposals = 0;
  drops = 0;

  private readonly autoplay: boolean;

  constructor(autoplay: boolean) {
    this.autoplay = autoplay;
    this.wanted = autoplay;
  }

  get live(): boolean { return this.liveFlag; }
  get advancing(): boolean { return this.advancingFlag; }

  setMounted(value: boolean): void {
    if (value) {
      if (!this.liveFlag) { this.liveFlag = true; this.instantiations += 1; }
      this.settle();
      return;
    }
    if (this.liveFlag) { this.liveFlag = false; this.disposals += 1; }
    this.settle();
    this.wanted = this.autoplay;        // a fresh instance forgets the imperative state
    this.time = 0;
    this.frame = 0;
    this.lastTick = null;
  }

  setVisible(value: boolean): void { this.visible = value; this.settle(); }
  setActive(value: boolean): void { this.active = value; this.settle(); }
  play(): void { this.wanted = true; this.settle(); }
  pause(): void { this.wanted = false; this.settle(); }

  private settle(): void {
    const want = this.liveFlag && this.wanted && this.visible && this.active;
    if (want && !this.advancingFlag) {
      this.advancingFlag = true;
      this.starts += 1;
      this.lastTick = null;
    } else if (!want && this.advancingFlag) {
      this.advancingFlag = false;
      this.pauses += 1;
    }
  }

  /** one raw platform tick (ms); the advance to apply, or null when dropped or coalesced */
  tick(nowMs: number): RiveAdvance | null {
    if (!this.advancingFlag) { this.drops += 1; return null; }
    if (this.lastTick === null) {
      this.lastTick = nowMs;
      const advance = { time: round6(this.time), delta: 0, frame: this.frame };
      this.frame += 1;
      return advance;
    }
    const gap = nowMs - this.lastTick;
    if (gap < RIVE_FRAME_MIN_INTERVAL_MS) { this.drops += 1; return null; }
    this.lastTick = nowMs;
    const delta = gap / 1000;
    this.time += delta;
    const advance = { time: round6(this.time), delta: round6(delta), frame: this.frame };
    this.frame += 1;
    return advance;
  }
}

/** the pure fold the corpus pins: an autoplay flag plus a lifecycle/tick event list */
export function rivePlaybackSchedule(
  autoplay: boolean, events: readonly RivePlaybackEvent[],
): RivePlaybackFold {
  const loop = new RivePlayback(autoplay);
  const emitted: RiveAdvance[] = [];
  for (const event of events) {
    switch (event.type) {
      case "mount": loop.setMounted(true); break;
      case "unmount": loop.setMounted(false); break;
      case "visible": loop.setVisible(event.value); break;
      case "active": loop.setActive(event.value); break;
      case "play": loop.play(); break;
      case "pause": loop.pause(); break;
      default: {
        const advance = loop.tick(event.at);
        if (advance !== null) emitted.push(advance);
      }
    }
  }
  return {
    emitted,
    starts: loop.starts, pauses: loop.pauses,
    instantiations: loop.instantiations, disposals: loop.disposals, drops: loop.drops,
    advancing: loop.advancing, live: loop.live,
  };
}

// ── residency: a list of animations, bounded ─────────────────────────────────────────

export type RiveResidencyEvent = { readonly key: string; readonly visible: boolean };

export type RiveResidencyFold = {
  readonly live: string[];
  readonly instantiated: number;
  readonly disposed: number;
};

/**
 * At most `capacity` live artboards, most-recently-visible first. An offscreen row is
 * DEMOTED rather than disposed (it keeps its instance while there is room) and is evicted
 * before any visible one; eviction disposes, and a returning row is re-instantiated. That
 * re-instantiation is the price of the cap and the corpus counts it, because "bounded
 * memory" is a number a fixture can assert while an allocation is not.
 */
export function riveResidency(
  capacity: number, events: readonly RiveResidencyEvent[],
): RiveResidencyFold {
  const cap = Math.max(1, Math.floor(Number.isFinite(capacity) ? capacity : 1));
  const live: string[] = [];
  let instantiated = 0;
  let disposed = 0;
  for (const event of events) {
    const at = live.indexOf(event.key);
    if (!event.visible) {
      if (at >= 0) { live.splice(at, 1); live.push(event.key); }
      continue;
    }
    if (at >= 0) live.splice(at, 1);
    else instantiated += 1;
    live.unshift(event.key);
    while (live.length > cap) { live.pop(); disposed += 1; }
  }
  return { live, instantiated, disposed };
}

// ── event payloads ───────────────────────────────────────────────────────────────────

export type RiveStateChange = { readonly machine: string; readonly state: string };

/** `on:stateChange` fires on a TRANSITION, never on an advance: a state that survives sixty
 *  frames is one emission, and returning to a previous state emits again. */
export function riveStateChanges(
  machine: string, states: readonly (string | null | undefined)[],
): RiveStateChange[] {
  const out: RiveStateChange[] = [];
  let last: string | null = null;
  for (const raw of states) {
    const name = raw === null || raw === undefined ? "" : String(raw).trim();
    if (name === "" || name === last) continue;
    last = name;
    out.push({ machine, state: name });
  }
  return out;
}

export type RiveEventPayload = {
  readonly name: string;
  readonly properties: { [key: string]: boolean | number | string };
};

export type RiveEventFold = { readonly payload: RiveEventPayload | null; readonly dropped: number };

/**
 * `on:event` is `{name, properties}`. Properties keep booleans, finite numbers and strings,
 * in sorted key order so three renderers agree; anything else is dropped and counted,
 * because a bus payload is data and a nested handle is not portable.
 *
 * A Rive `openUrl` event arrives here as ordinary properties (`url`, `target`) and NOTHING
 * NAVIGATES. The .riv file is an asset, and an asset that could open a URL by itself would
 * be a hole an OTA-delivered animation walks straight through.
 */
export function riveEventPayload(
  name: string | null | undefined, properties: { readonly [key: string]: unknown } | null | undefined,
): RiveEventFold {
  const trimmed = name === null || name === undefined ? "" : String(name).trim();
  if (trimmed === "") return { payload: null, dropped: 0 };
  const out: { [key: string]: boolean | number | string } = {};
  let dropped = 0;
  for (const key of Object.keys(properties ?? {}).sort()) {
    const value = (properties as { [key: string]: unknown })[key];
    if (typeof value === "boolean" || typeof value === "string") out[key] = value;
    else if (typeof value === "number" && Number.isFinite(value)) out[key] = round6(value);
    else dropped += 1;
  }
  return { payload: { name: trimmed, properties: out }, dropped };
}

export type RiveLoadPayload = {
  readonly artboard: string | null;
  readonly stateMachine: string | null;
  readonly animation: string | null;
  readonly width: number;
  readonly height: number;
};

/** `on:load` carries the resolved selection plus the artboard's INTRINSIC size, which is
 *  what a caller needs to size a box around it. */
export function riveLoadPayload(
  selection: RiveSelection, width: number, height: number,
): RiveLoadPayload {
  return {
    artboard: selection.artboard,
    stateMachine: selection.stateMachine,
    animation: selection.animation,
    width: round6(Number.isFinite(width) ? width : 0),
    height: round6(Number.isFinite(height) ? height : 0),
  };
}

export const RIVE_ERROR_MESSAGES: { readonly [code: string]: string } = {
  not_found: "the artboard, state machine or animation this <rive> names is not in the file",
  no_source: "<rive> has no src",
  decode_failed: "this .riv file could not be decoded",
  load_failed: "the .riv file could not be loaded",
  unsupported_platform: "this platform ships no Rive runtime",
};

export type RiveErrorPayload = { readonly code: string; readonly message: string };

/** `on:error` over a closed code set; an unknown code keeps the code and takes the generic
 *  message rather than vanishing, and a blank code IS `load_failed`. */
export function riveErrorPayload(code: string | null | undefined): RiveErrorPayload {
  let resolved = code === null || code === undefined ? "" : String(code).trim();
  if (resolved === "") resolved = "load_failed";
  return { code: resolved, message: RIVE_ERROR_MESSAGES[resolved] ?? "this <rive> could not be played" };
}

// ── accessibility ────────────────────────────────────────────────────────────────────

/** the same ten gesture words `<canvas>` uses. `on:stateChange` and `on:event` are absent
 *  on purpose: an animation reporting what it did is not a control. */
export const RIVE_GESTURE_HANDLERS: readonly string[] = [
  "on:tap", "on:doubletap", "on:longpress", "on:drag", "on:pan",
  "on:pinch", "on:rotate", "on:swipe", "on:press", "on:adjust",
];

export const RIVE_A11Y_LINT_CODE = "rive-a11y-label";
export const RIVE_A11Y_LINT_MESSAGE =
  "<rive> with a gesture handler needs a11yLabel — an animation is opaque to assistive tech";

export type RiveA11yChild = {
  readonly role: string; readonly label: string; readonly value: string | null;
};

export type RiveA11yLint = { readonly code: string; readonly level: string; readonly message: string };

export type RiveA11yVerdict = {
  readonly interactive: boolean;
  readonly label: string | null;
  readonly children: RiveA11yChild[];
  readonly role: "none" | "group" | "button" | "image";
  readonly hidden: boolean;
  readonly lint: RiveA11yLint | null;
};

/**
 * The `<canvas>` verdict shape applied to an animation: same six fields, same three-surface
 * fold, one extra input. A Rive state machine can carry its OWN pointer listeners inside the
 * .riv file, so the component can be interactive with no `on:` handler in sight. That flips
 * `interactive` and the role but emits NO lint, because the linter reads markup and markup
 * cannot see inside an asset. Two verdicts, one fold, and the difference is stated rather
 * than fudged.
 */
export function riveA11y(
  attrs: { readonly [name: string]: unknown },
  a11yChildren?: readonly { role?: string; label?: string; value?: string | null }[] | null,
  hasListeners?: boolean,
): RiveA11yVerdict {
  const handled = RIVE_GESTURE_HANDLERS.some((name) => {
    const raw = attrs[name];
    return raw !== undefined && raw !== null && String(raw).trim() !== "";
  });
  const interactive = handled || hasListeners === true;
  const rawLabel = attrs["a11yLabel"];
  const trimmed = rawLabel === undefined || rawLabel === null ? "" : String(rawLabel).trim();
  const label = trimmed === "" ? null : trimmed;
  const children: RiveA11yChild[] = (a11yChildren ?? []).map((child) => ({
    role: child.role ?? "image",
    label: child.label ?? "",
    value: child.value ?? null,
  }));
  const declared = label !== null || children.length > 0;
  const role: RiveA11yVerdict["role"] = children.length > 0
    ? "group"
    : interactive
      ? (label !== null ? "button" : "group")
      : (label !== null ? "image" : "none");
  return {
    interactive,
    label,
    children,
    role,
    hidden: !interactive && !declared,
    lint: handled && !declared
      ? { code: RIVE_A11Y_LINT_CODE, level: "error", message: RIVE_A11Y_LINT_MESSAGE }
      : null,
  };
}
