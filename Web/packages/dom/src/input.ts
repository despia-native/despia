//
//  input.ts — G4 UNIFIED INPUT, the WEB wiring (dsx-game.md §2 G4).
//
//  The DECISIONS all live in the shared kernel (@despia/kernel input.ts, corpus
//  OpenSource/Conformance/input/{mappings,axis}.json): the declaration → binding table, the
//  axis folds, the edge law. This file is the plumbing that no corpus can judge — real
//  keydown/keyup, the Gamepad API, and pointer-gesture recognition — plus the two consumer
//  surfaces:
//
//    • `on:input.<name>` on any element → the STANDARD gated handler path (mount.ts
//      wireInput subscribes; `on:input.<name>.throttle/.debounce` work unchanged).
//    • `dsx.input.<name>` → published to `global.input.<name>` on the app store, so markup
//      and actions read it as an ordinary tracked, reactive value (JSE.normalizeScope maps
//      the `input` scope word; no new dispatch path exists).
//
//  THE LOOP-EXISTENCE LAW, APPLIED TO INPUT. Keyboard and touch commit on the EVENT EDGE —
//  they never spin a frame loop. Only the Gamepad API must be polled, so:
//    1 · any existing frame loop (the `<scene>` rAF) calls `inputHostFrame()` once per
//        frame — that is the "poll inside the loop you already have" case, zero new loops;
//    2 · when nothing external has driven a frame recently, and only while some binding
//        declares a gamepad leg AND a pad is connected, a gated rAF takes over — because
//        input is NOT scene-scoped (a page may declare `<input>` and never mount a scene).
//  The internal loop stops itself the moment an external driver ticks, so the two can
//  never both run.
//

import {
  DSXState, resolveInputDeclarations, InputMachine,
  type InputBinding, type InputDeclaration, type InputEvent,
} from "@despia/kernel";

/** How long an external frame driver keeps ownership before the gated rAF takes back over. */
const EXTERNAL_DRIVE_TTL_MS = 250;

/** Pointer-gesture thresholds — the web recognizer's constants (platform plumbing, not law). */
const TAP_MAX_MS = 250;
const TAP_MAX_PX = 10;
const HOLD_MS = 350;
const SWIPE_MIN_PX = 32;
const SWIPE_MAX_MS = 600;

type Owner = object;

type Subscriber = (event: InputEvent) => void;

const owners = new Map<Owner, InputDeclaration[]>();
const subscribers = new Map<string, Set<Subscriber>>();
let machine = new InputMachine([]);
let bindings: InputBinding[] = [];
let published = new Map<string, boolean | { x: number; y: number }>();

const listening = { keys: false, pad: false, touch: false };
let rafId: number | null = null;
let lastExternalDrive = 0;
let holdTimer: ReturnType<typeof setTimeout> | null = null;

function now(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

// ── the merged binding table ────────────────────────────────────────────────────────────

/** Diagnostics from the LAST rebuild — surfaced to hosts (the oracle reads them). */
export let inputDiagnostics: Array<{ code: string; name: string; word?: string }> = [];

function rebuild(): void {
  const all: InputDeclaration[] = [];
  for (const decls of owners.values()) all.push(...decls);
  const resolved = resolveInputDeclarations(all);
  bindings = resolved.bindings;
  inputDiagnostics = resolved.diagnostics.map((d) => ({ ...d }));
  machine.reset(bindings);
  // Seed every declared name so a read BEFORE any device event is the honest resting
  // value rather than null — the typed-absence rule (durability.md P4).
  const next = new Map<string, boolean | { x: number; y: number }>();
  for (const b of bindings) next.set(b.name, b.axis ? { x: 0, y: 0 } : false);
  for (const [name, value] of next) {
    const before = published.get(name);
    if (before === undefined || !sameValue(before, value)) DSXState.set(`input.${name}`, value);
  }
  for (const name of published.keys()) if (!next.has(name)) DSXState.set(`input.${name}`, null);
  published = next;
  syncListeners();
}

function sameValue(a: boolean | { x: number; y: number }, b: boolean | { x: number; y: number }): boolean {
  if (typeof a === "boolean" || typeof b === "boolean") return a === b;
  return a.x === b.x && a.y === b.y;
}

function needsKeys(): boolean { return bindings.some((b) => b.keys.length > 0); }
function needsPad(): boolean { return bindings.some((b) => b.buttons.length > 0 || b.sticks.length > 0); }
function needsTouch(): boolean { return bindings.some((b) => b.touch.length > 0); }

const claimedKeys = (): Set<string> => {
  const set = new Set<string>();
  for (const b of bindings) for (const k of b.keys) set.add(k);
  return set;
};

// ── publish + dispatch ──────────────────────────────────────────────────────────────────

function commit(): void {
  const result = machine.commit();
  for (const [name, value] of Object.entries(result.values)) {
    const before = published.get(name);
    if (before === undefined || !sameValue(before, value)) {
      published.set(name, value);
      DSXState.set(`input.${name}`, value);
    }
  }
  for (const event of result.events) {
    const set = subscribers.get(event.name);
    if (set === undefined) continue;
    for (const fn of [...set]) fn(event);
  }
}

// ── device plumbing ─────────────────────────────────────────────────────────────────────

/** Browser key event → the canonical kernel key word, or null when it is not vocabulary.
 *  `code` wins for letters/digits so the binding is LAYOUT-INDEPENDENT (a game's WASD stays
 *  under the same fingers on AZERTY); everything else reads `key`. */
export function canonicalBrowserKey(code: string, key: string): string | null {
  if (code === "Space" || key === " " || key === "Spacebar") return "Space";
  if (/^Key[A-Z]$/.test(code)) return code.substring(3);
  if (/^Digit[0-9]$/.test(code)) return code.substring(5);
  switch (key) {
    case "ArrowUp": case "ArrowDown": case "ArrowLeft": case "ArrowRight":
    case "Enter": case "Escape": case "Tab": case "Shift": case "Control":
    case "Alt": case "Meta": case "Backspace":
      return key;
    default: break;
  }
  if (key.length === 1) {
    const upper = key.toUpperCase();
    if (upper >= "A" && upper <= "Z") return upper;
    if (key >= "0" && key <= "9") return key;
  }
  return null;
}

/** An editable target owns the keyboard — a game binding never steals a typed character. */
function editableTarget(target: EventTarget | null): boolean {
  if (target === null || typeof target !== "object") return false;
  const el = target as HTMLElement;
  const tag = (el.tagName ?? "").toUpperCase();
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return el.isContentEditable === true;
}

/** An INTERACTIVE target owns its pointer — a touch word never hijacks a control the
 *  user is actually operating (found by the /game walk: `touch="tap"` on `jump` made
 *  every BUTTON click also fire the cannon — the "Fire the ball" button fired twice).
 *  Keyboard keeps the narrower editable guard: keys must keep working while a button
 *  holds focus. The walk is closest(), so a label inside a button counts. */
function interactiveTarget(target: EventTarget | null): boolean {
  if (editableTarget(target)) return true;
  if (target === null || typeof target !== "object") return false;
  const el = target as HTMLElement;
  if (typeof el.closest !== "function") return false;
  return el.closest("button, a[href], [role='button'], [role='link'], summary, label, audio[controls], video[controls]") !== null;
}

/** `touch=` names a CONTACT gesture, not every event delivered through Pointer Events.
 *  Browsers report an ordinary mouse click as pointerType="mouse"; treating that click
 *  as `touch="tap"` made a canvas focus click activate the game before the first key
 *  press. A pen is contact input and follows the same gesture recognizer as touch. */
function isContactPointer(event: Pick<PointerEvent, "pointerType">): boolean {
  return event.pointerType === "touch" || event.pointerType === "pen";
}

const onKeyDown = (event: KeyboardEvent): void => {
  if (event.isComposing || editableTarget(event.target)) return;
  const key = canonicalBrowserKey(event.code ?? "", event.key ?? "");
  if (key === null || !claimedKeys().has(key)) return;
  // A claimed Space/Arrow must not also scroll the page — the game owns it.
  event.preventDefault();
  if (event.repeat) return;      // auto-repeat is not a new press edge (the edge law)
  machine.keyDown(key);
  commit();
};

const onKeyUp = (event: KeyboardEvent): void => {
  const key = canonicalBrowserKey(event.code ?? "", event.key ?? "");
  if (key === null) return;
  machine.keyUp(key);
  commit();
};

const onBlur = (): void => {
  machine.releaseKeys();
  commit();
};

// pointer gestures ------------------------------------------------------------------------
let pointerStart: { x: number; y: number; t: number; id: number } | null = null;

const onPointerDown = (event: PointerEvent): void => {
  if (!isContactPointer(event)) return;
  if (interactiveTarget(event.target)) return;
  pointerStart = { x: event.clientX, y: event.clientY, t: now(), id: event.pointerId };
  if (holdTimer !== null) clearTimeout(holdTimer);
  holdTimer = setTimeout(() => {
    holdTimer = null;
    if (pointerStart === null) return;
    machine.touch("hold");
    commit();
  }, HOLD_MS);
};

const onPointerUp = (event: PointerEvent): void => {
  const start = pointerStart;
  if (!isContactPointer(event) || start === null || start.id !== event.pointerId) return;
  pointerStart = null;
  if (holdTimer !== null) { clearTimeout(holdTimer); holdTimer = null; }
  machine.touchRelease("hold");
  const dx = event.clientX - start.x;
  const dy = event.clientY - start.y;
  const dt = now() - start.t;
  const adx = Math.abs(dx);
  const ady = Math.abs(dy);
  if (dt <= TAP_MAX_MS && adx <= TAP_MAX_PX && ady <= TAP_MAX_PX) machine.touch("tap");
  else if (dt <= SWIPE_MAX_MS && (adx >= SWIPE_MIN_PX || ady >= SWIPE_MIN_PX)) {
    if (adx >= ady) machine.touch(dx > 0 ? "swipeRight" : "swipeLeft");
    else machine.touch(dy > 0 ? "swipeDown" : "swipeUp");
  }
  commit();
};

const onPointerCancel = (event: PointerEvent): void => {
  if (!isContactPointer(event) || pointerStart?.id !== event.pointerId) return;
  pointerStart = null;
  if (holdTimer !== null) { clearTimeout(holdTimer); holdTimer = null; }
  machine.touchRelease("hold");
  commit();
};

// gamepad ---------------------------------------------------------------------------------

/** Read pad 0 (single-player by law — multi-player routing is a named absence). */
function pollGamepads(): void {
  const nav = globalThis.navigator as Navigator & { getGamepads?: () => Array<Gamepad | null> };
  if (typeof nav?.getGamepads !== "function") { machine.gamepad(null); return; }
  const pads = nav.getGamepads();
  for (const pad of pads) {
    if (pad === null || pad.connected !== true) continue;
    machine.gamepad({ buttons: pad.buttons.map((b) => (b.pressed ? 1 : b.value)), axes: [...pad.axes] });
    return;
  }
  machine.gamepad(null);
}

/**
 * Poll + commit from an EXISTING frame loop. The `<scene>` rAF calls this once per frame;
 * calling it also parks the gated internal loop, so the two never both run.
 */
export function inputHostFrame(): void {
  lastExternalDrive = now();
  if (!needsPad()) return;
  pollGamepads();
  commit();
}

function pumpFrame(): void {
  rafId = null;
  if (!needsPad()) return;
  if (now() - lastExternalDrive < EXTERNAL_DRIVE_TTL_MS) return;   // an external loop owns it
  pollGamepads();
  commit();
  schedulePump();
}

function schedulePump(): void {
  if (rafId !== null || typeof requestAnimationFrame !== "function") return;
  rafId = requestAnimationFrame(pumpFrame);
}

function padConnected(): boolean {
  const nav = globalThis.navigator as Navigator & { getGamepads?: () => Array<Gamepad | null> };
  if (typeof nav?.getGamepads !== "function") return false;
  return nav.getGamepads().some((p) => p !== null && p.connected === true);
}

const onPadChange = (): void => { syncListeners(); schedulePump(); };

// ── listener lifecycle ──────────────────────────────────────────────────────────────────

/** Attach only the device listeners the declared bindings actually need — a page whose
 *  bindings name no touch word never installs a pointer recognizer, and a page with no
 *  `<input>` at all installs nothing (the zero-cost-static law). */
function syncListeners(): void {
  const want = { keys: needsKeys(), pad: needsPad(), touch: needsTouch() };
  if (typeof window === "undefined") return;
  const on = (kind: "keys" | "pad" | "touch", add: boolean): void => {
    if (listening[kind] === add) return;
    listening[kind] = add;
    const bind = add
      ? (t: string, fn: EventListener, o?: AddEventListenerOptions) => window.addEventListener(t, fn, o)
      : (t: string, fn: EventListener) => window.removeEventListener(t, fn);
    if (kind === "keys") {
      bind("keydown", onKeyDown as EventListener);
      bind("keyup", onKeyUp as EventListener);
      bind("blur", onBlur as EventListener);
    } else if (kind === "pad") {
      bind("gamepadconnected", onPadChange as EventListener);
      bind("gamepaddisconnected", onPadChange as EventListener);
    } else {
      bind("pointerdown", onPointerDown as EventListener, { passive: true });
      bind("pointerup", onPointerUp as EventListener, { passive: true });
      bind("pointercancel", onPointerCancel as EventListener, { passive: true });
    }
  };
  on("keys", want.keys);
  on("pad", want.pad);
  on("touch", want.touch);
  if (want.pad && padConnected()) schedulePump();
}

// ── the public surface ──────────────────────────────────────────────────────────────────

/** Register a surface's head `<input>` declarations; the returned disposer unregisters. */
export function registerInputDeclarations(owner: Owner, decls: readonly InputDeclaration[]): () => void {
  if (decls.length === 0) return () => {};
  owners.set(owner, decls.map((d) => ({ ...d })));
  rebuild();
  return () => {
    if (!owners.delete(owner)) return;
    rebuild();
  };
}

/** Subscribe to a binding's press EDGE — the `on:input.<name>` consumer path. */
export function onInputEdge(name: string, fn: Subscriber): () => void {
  const set = subscribers.get(name) ?? new Set<Subscriber>();
  subscribers.set(name, set);
  set.add(fn);
  return () => {
    set.delete(fn);
    if (set.size === 0) subscribers.delete(name);
  };
}

/** The live resolved table — introspection for hosts, tests and the browser oracle. */
export function inputBindings(): readonly InputBinding[] { return bindings; }

/** Synthesize a raw device event (the G5 `input.synthesize` seam and the test path). */
export function synthesizeInput(op:
  | { op: "keyDown" | "keyUp"; key: string }
  | { op: "touch" | "touchRelease"; word: string }
  | { op: "gamepad"; buttons: number[]; axes: number[] }): void {
  if (op.op === "keyDown") machine.keyDown(op.key);
  else if (op.op === "keyUp") machine.keyUp(op.key);
  else if (op.op === "touch") machine.touch(op.word);
  else if (op.op === "touchRelease") machine.touchRelease(op.word);
  else if (op.op === "gamepad") machine.gamepad({ buttons: op.buttons, axes: op.axes });
  commit();
}

/** Test seam: drop every registration and listener. */
export function resetInputRuntime(): void {
  owners.clear();
  subscribers.clear();
  machine = new InputMachine([]);
  bindings = [];
  for (const name of published.keys()) DSXState.set(`input.${name}`, null);
  published = new Map();
  inputDiagnostics = [];
  if (holdTimer !== null) { clearTimeout(holdTimer); holdTimer = null; }
  pointerStart = null;
  syncListeners();
}
