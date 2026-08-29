//
//  input.ts — G4 UNIFIED INPUT, the shared kernel (dsx-game.md §2 G4).
//
//  ONE head declaration — `<input as="jump" keys="Space ArrowUp" gamepad="A" touch="tap"/>` —
//  bound to keyboard, gamepad and touch on every target. This file owns the two halves that
//  MUST be identical on all three runtimes and are therefore corpus-pinned
//  (OpenSource/Conformance/input/{mappings,axis}.json, plus attenuation.json for the audio
//  fold at the bottom):
//
//    1 · RESOLUTION — declaration attributes → one `InputBinding` record, with every
//        unknown word dropped behind exactly ONE Article-7 diagnostic.
//    2 · THE FOLD — raw device events → per-name pressed/axis values + press-edge events.
//
//  Everything platform-shaped lives OUTSIDE: @despia-native/dom's input.ts binds keydown/keyup, polls
//  the Gamepad API inside the ONE existing frame loop and recognises touch gestures; the
//  Kotlin twin (despia.engine.input.SceneInput) and the Swift twin (SceneInput.swift) do the
//  same for their toolkits. Keeping the DECISION separate from the PLUMBING is what lets one
//  corpus judge three runtimes.
//
//  The law in full: OpenSource/Conformance/input/README.md ("The G4 laws — unified input").
//

/** Analog stick deadzone when a declaration does not name one. */
export const INPUT_DEFAULT_DEADZONE = 0.15;
/** Largest deadzone a declaration may ask for; beyond it the stick would be unusable. */
export const INPUT_MAX_DEADZONE = 0.9;

/** Canonical gamepad button words → the W3C standard-mapping button index. */
export const INPUT_PAD_BUTTONS: { readonly [word: string]: number } = {
  A: 0, B: 1, X: 2, Y: 3, L: 4, R: 5, L2: 6, R2: 7,
  Select: 8, Start: 9, LStick: 10, RStick: 11,
  DPadUp: 12, DPadDown: 13, DPadLeft: 14, DPadRight: 15,
};

/** Canonical stick words → their (x, y) indices in the standard-mapping axes array. */
export const INPUT_PAD_STICKS: { readonly [word: string]: readonly [number, number] } = {
  leftStick: [0, 1], rightStick: [2, 3],
};

/** Shorthand key SETS. The order is POSITIONAL and load-bearing: [up, left, down, right]. */
export const INPUT_KEY_SETS: { readonly [set: string]: readonly string[] } = {
  wasd: ["W", "A", "S", "D"],
  arrows: ["ArrowUp", "ArrowLeft", "ArrowDown", "ArrowRight"],
  zqsd: ["Z", "Q", "S", "D"],
  ijkl: ["I", "J", "K", "L"],
};

/** Touch gesture words. `hold` is sustained; every other word is momentary. */
export const INPUT_TOUCH_WORDS: { readonly [lower: string]: string } = {
  tap: "tap", hold: "hold",
  swipeleft: "swipeLeft", swiperight: "swipeRight",
  swipeup: "swipeUp", swipedown: "swipeDown",
};

/** The momentary touch words — pressed for exactly the frame they arrive in. */
export const INPUT_MOMENTARY_TOUCH: readonly string[] = ["tap", "swipeLeft", "swipeRight", "swipeUp", "swipeDown"];

const KEY_ALIASES: { readonly [lower: string]: string } = {
  space: "Space",
  arrowup: "ArrowUp", up: "ArrowUp",
  arrowdown: "ArrowDown", down: "ArrowDown",
  arrowleft: "ArrowLeft", left: "ArrowLeft",
  arrowright: "ArrowRight", right: "ArrowRight",
  enter: "Enter", return: "Enter",
  escape: "Escape", esc: "Escape",
  tab: "Tab", shift: "Shift",
  control: "Control", ctrl: "Control",
  alt: "Alt", option: "Alt",
  meta: "Meta", cmd: "Meta", command: "Meta",
  backspace: "Backspace",
};

const PAD_ALIASES: { readonly [lower: string]: string } = {
  a: "A", b: "B", x: "X", y: "Y",
  l: "L", l1: "L", lb: "L", r: "R", r1: "R", rb: "R",
  l2: "L2", lt: "L2", r2: "R2", rt: "R2",
  select: "Select", back: "Select", start: "Start",
  lstick: "LStick", l3: "LStick", rstick: "RStick", r3: "RStick",
  dpadup: "DPadUp", dpaddown: "DPadDown", dpadleft: "DPadLeft", dpadright: "DPadRight",
};

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/** One diagnostic code from the table in the corpus README. */
export type InputDiagnosticCode =
  | "input-as" | "input-duplicate" | "input-axis" | "input-deadzone"
  | "input-key" | "input-gamepad" | "input-touch"
  | "input-axis-keys" | "input-axis-buttons" | "input-touch-axis" | "input-stick-button";

export interface InputDiagnostic {
  code: InputDiagnosticCode;
  /** the `as` this declaration asked for (empty when it never named one) */
  name: string;
  /** the offending word, when the defect is one word rather than the whole declaration */
  word?: string;
}

/** The authored `<input>` attributes, exactly as markup carries them. */
export interface InputDeclaration {
  as?: string;
  keys?: string;
  gamepad?: string;
  touch?: string;
  axis?: string;
  deadzone?: string;
}

/** The RESOLVED binding — the record every runtime folds device events against. */
export interface InputBinding {
  name: string;
  axis: boolean;
  deadzone: number;
  /** button mode: any-of. axis mode: exactly 0 or 4, positional [up, left, down, right]. */
  keys: string[];
  /** gamepad button words. axis mode: exactly 0 or 4, positional. */
  buttons: string[];
  /** gamepad stick words (axis mode only). */
  sticks: string[];
  /** touch gesture words (button mode only). */
  touch: string[];
}

export interface InputResolution {
  bindings: InputBinding[];
  diagnostics: InputDiagnostic[];
}

function words(raw: string | undefined): string[] {
  return String(raw ?? "").split(/\s+/).filter((w) => w.length > 0);
}

/** One authored key word → its canonical key(s), or null when the word is not vocabulary. */
export function inputCanonicalKeys(word: string): string[] | null {
  const low = word.toLowerCase();
  const set = INPUT_KEY_SETS[low];
  if (set !== undefined) return [...set];
  const alias = KEY_ALIASES[low];
  if (alias !== undefined) return [alias];
  if (word.length === 1) {
    const upper = word.toUpperCase();
    if (upper >= "A" && upper <= "Z") return [upper];
    if (word >= "0" && word <= "9") return [word];
  }
  return null;
}

/**
 * Declarations → bindings. Pure and total: a malformed word never throws and never takes
 * the rest of the binding with it — it drops behind ONE diagnostic (Article 7).
 */
export function resolveInputDeclarations(decls: readonly InputDeclaration[]): InputResolution {
  const bindings: InputBinding[] = [];
  const diagnostics: InputDiagnostic[] = [];
  const seen = new Set<string>();
  for (const d of decls) {
    const name = String(d.as ?? "").trim();
    if (name.length === 0 || !IDENTIFIER.test(name)) {
      diagnostics.push({ code: "input-as", name });
      continue;
    }
    if (seen.has(name)) {
      diagnostics.push({ code: "input-duplicate", name });
      continue;
    }
    seen.add(name);

    const rawAxis = d.axis === undefined ? "" : String(d.axis);
    let axis = false;
    if (rawAxis.length > 0) {
      if (rawAxis === "true") axis = true;
      else if (rawAxis !== "false") diagnostics.push({ code: "input-axis", name, word: rawAxis });
    }

    let deadzone = INPUT_DEFAULT_DEADZONE;
    const rawDz = d.deadzone === undefined ? "" : String(d.deadzone).trim();
    if (rawDz.length > 0) {
      const v = Number(rawDz);
      if (!Number.isFinite(v) || v < 0 || v > INPUT_MAX_DEADZONE) {
        diagnostics.push({ code: "input-deadzone", name, word: rawDz });
      } else {
        deadzone = v;
      }
    }

    const keys: string[] = [];
    for (const w of words(d.keys)) {
      const got = inputCanonicalKeys(w);
      if (got === null) { diagnostics.push({ code: "input-key", name, word: w }); continue; }
      for (const k of got) if (!keys.includes(k)) keys.push(k);
    }

    const buttons: string[] = [];
    const sticks: string[] = [];
    for (const w of words(d.gamepad)) {
      const low = w.toLowerCase();
      if (low === "leftstick" || low === "rightstick") {
        const stick = low === "leftstick" ? "leftStick" : "rightStick";
        if (!sticks.includes(stick)) sticks.push(stick);
        continue;
      }
      const button = PAD_ALIASES[low];
      if (button !== undefined) {
        if (!buttons.includes(button)) buttons.push(button);
        continue;
      }
      diagnostics.push({ code: "input-gamepad", name, word: w });
    }

    let touch: string[] = [];
    for (const w of words(d.touch)) {
      const canonical = INPUT_TOUCH_WORDS[w.toLowerCase()];
      if (canonical === undefined) { diagnostics.push({ code: "input-touch", name, word: w }); continue; }
      if (!touch.includes(canonical)) touch.push(canonical);
    }

    // Mode constraints — an axis reads its legs POSITIONALLY, so a wrong count is not a
    // usable axis and drops loudly rather than half-working.
    let axisKeys = keys;
    let axisButtons = buttons;
    let axisSticks = sticks;
    if (axis) {
      if (axisKeys.length !== 0 && axisKeys.length !== 4) {
        diagnostics.push({ code: "input-axis-keys", name });
        axisKeys = [];
      }
      if (axisButtons.length !== 0 && axisButtons.length !== 4) {
        diagnostics.push({ code: "input-axis-buttons", name });
        axisButtons = [];
      }
      if (touch.length > 0) {
        diagnostics.push({ code: "input-touch-axis", name });
        touch = [];
      }
    } else if (axisSticks.length > 0) {
      diagnostics.push({ code: "input-stick-button", name });
      axisSticks = [];
    }

    bindings.push({ name, axis, deadzone, keys: axisKeys, buttons: axisButtons, sticks: axisSticks, touch });
  }
  return { bindings, diagnostics };
}

// ── the axis folds ──────────────────────────────────────────────────────────────────────

/** The DIGITAL fold: four booleans → a vector, +x right / +y up, diagonals normalized. */
export function inputDigitalAxis(up: boolean, left: boolean, down: boolean, right: boolean): [number, number] {
  let x = (right ? 1 : 0) - (left ? 1 : 0);
  let y = (up ? 1 : 0) - (down ? 1 : 0);
  // sqrt-of-squares, never hypot — the physics precedent: IEEE doubles must agree across
  // runtimes, and hypot()'s intermediate scaling is implementation-defined.
  const len = Math.sqrt(x * x + y * y);
  if (len > 1) { x = x / len; y = y / len; }
  return [x, y];
}

/**
 * The ANALOG fold: a raw stick pair → a vector. Raw Y is DOWN-positive on every platform,
 * so it is negated here and the +y-up convention holds everywhere. The deadzone applies
 * RADIALLY and then rescales, so the live range stays a full 0..1 and the magnitude never
 * exceeds 1 (an overshooting stick clamps to the unit circle).
 */
export function inputAnalogAxis(rawX: number, rawY: number, deadzone: number): [number, number] {
  const x = rawX;
  const y = -rawY;
  const len = Math.sqrt(x * x + y * y);
  if (len <= deadzone) return [0, 0];
  const clamped = len > 1 ? 1 : len;
  const scale = ((clamped - deadzone) / (1 - deadzone)) / len;
  return [x * scale, y * scale];
}

// ── the state machine ───────────────────────────────────────────────────────────────────

/** A gamepad snapshot as every platform can produce it. */
export interface InputPadSnapshot {
  buttons: readonly number[];
  axes: readonly number[];
}

/** An axis read — the shape `dsx.input.<name>` returns for an `axis="true"` binding. */
export interface InputAxisValue { x: number; y: number }

/** One press-edge event; the payload a `on:input.<name>` handler receives. */
export interface InputEvent { name: string; x: number; y: number }

export interface InputCommit {
  /** live state per binding name — boolean for a button, `{x,y}` for an axis */
  values: { [name: string]: boolean | InputAxisValue };
  /** press-edge events, in DECLARATION order */
  events: InputEvent[];
}

/**
 * The fold, as a small mutable machine. Every platform pushes raw events in and calls
 * `commit()` once per frame; the machine owns the edge law and the momentary-touch pulse.
 */
export class InputMachine {
  readonly bindings: InputBinding[];
  private readonly down = new Set<string>();
  private pad: InputPadSnapshot | null = null;
  private pulse = new Set<string>();
  private readonly held = new Set<string>();
  private readonly prev = new Map<string, boolean>();

  constructor(bindings: readonly InputBinding[]) {
    this.bindings = [...bindings];
    for (const b of this.bindings) this.prev.set(b.name, false);
  }

  /** Replace the whole binding table (a re-declared surface), keeping no stale edges. */
  reset(bindings: readonly InputBinding[]): void {
    this.bindings.length = 0;
    this.bindings.push(...bindings);
    this.prev.clear();
    for (const b of this.bindings) this.prev.set(b.name, false);
  }

  keyDown(key: string): void { this.down.add(key); }
  keyUp(key: string): void { this.down.delete(key); }
  /** Every held key released — the window-blur / app-background case. */
  releaseKeys(): void { this.down.clear(); }
  gamepad(pad: InputPadSnapshot | null): void { this.pad = pad; }
  /** A touch gesture arrived. `hold` becomes sustained; everything else is a one-frame pulse. */
  touch(word: string): void {
    if (word === "hold") this.held.add(word);
    else this.pulse.add(word);
  }
  touchRelease(word: string): void { this.held.delete(word); }

  private padButton(word: string): boolean {
    const pad = this.pad;
    if (pad === null) return false;
    const index = INPUT_PAD_BUTTONS[word];
    if (index === undefined || index >= pad.buttons.length) return false;
    return (pad.buttons[index] ?? 0) > 0;
  }

  /** Fold one frame: live values + the press-edge events, then clear the momentary pulse. */
  commit(): InputCommit {
    const values: { [name: string]: boolean | InputAxisValue } = {};
    const events: InputEvent[] = [];
    for (const b of this.bindings) {
      let pressed: boolean;
      let persistentPressed: boolean;
      let x = 0;
      let y = 0;
      if (b.axis) {
        let vec: [number, number] = [0, 0];
        if (this.pad !== null) {
          for (const stick of b.sticks) {
            const idx = INPUT_PAD_STICKS[stick];
            if (idx === undefined) continue;
            const axes = this.pad.axes;
            const rx = idx[0] < axes.length ? (axes[idx[0]] ?? 0) : 0;
            const ry = idx[1] < axes.length ? (axes[idx[1]] ?? 0) : 0;
            const candidate = inputAnalogAxis(rx, ry, b.deadzone);
            if (candidate[0] !== 0 || candidate[1] !== 0) { vec = candidate; break; }
          }
        }
        if (vec[0] === 0 && vec[1] === 0) {
          const k = b.keys.length === 4 ? b.keys : null;
          const p = b.buttons.length === 4 ? b.buttons : null;
          const dir = (i: number): boolean =>
            (k !== null && this.down.has(k[i]!)) || (p !== null && this.padButton(p[i]!));
          vec = inputDigitalAxis(dir(0), dir(1), dir(2), dir(3));
        }
        x = vec[0];
        y = vec[1];
        values[b.name] = { x, y };
        pressed = x !== 0 || y !== 0;
        persistentPressed = pressed;
      } else {
        const keyOrPad = b.keys.some((k) => this.down.has(k))
          || b.buttons.some((w) => this.padButton(w));
        const heldTouch = b.touch.some((t) => this.held.has(t));
        const momentaryTouch = b.touch.some((t) => this.pulse.has(t));
        persistentPressed = keyOrPad || heldTouch;
        pressed = persistentPressed || momentaryTouch;
        values[b.name] = pressed;
      }
      if (pressed && this.prev.get(b.name) !== true) events.push({ name: b.name, x, y });
      // A momentary touch exists for this commit only. Rearm it immediately while
      // preserving genuinely held key/pad/hold state, because Web/native contact
      // plumbing commits on event edges and does not manufacture an empty frame.
      this.prev.set(b.name, persistentPressed);
    }
    this.pulse = new Set<string>();
    return { values, events };
  }
}

// ── the audio half: the positional attenuation fold ─────────────────────────────────────

export const AUDIO_DEFAULT_REF_DISTANCE = 1;
export const AUDIO_DEFAULT_MAX_DISTANCE = 50;
export const AUDIO_DEFAULT_ROLLOFF = 1;

export interface AudioAttenuation {
  /** raw distance between listener and source (never clamped — the honest measurement) */
  distance: number;
  /** the clamped inverse-distance gain, 0 < gain ≤ 1 */
  gain: number;
  /** listener-relative stereo pan, −1 (left) … +1 (right) */
  pan: number;
}

/**
 * The positional-audio FOLD (corpus attenuation.json). Pure math: no platform audio API is
 * touched here, and none is touched by this rung at all — playing the folded numbers back
 * through a real 3D mixer is the named absence in the G4 landing record. The curve is
 * deliberately the Web Audio `inverse` panner model so the numbers hand straight to a
 * PannerNode on web and drive a native mixer identically.
 */
export function sceneAudioAttenuation(
  listener: readonly [number, number, number],
  source: readonly [number, number, number],
  opts: { ref?: number; max?: number; rolloff?: number } = {},
): AudioAttenuation {
  const ref = opts.ref ?? AUDIO_DEFAULT_REF_DISTANCE;
  const max = opts.max ?? AUDIO_DEFAULT_MAX_DISTANCE;
  const rolloff = opts.rolloff ?? AUDIO_DEFAULT_ROLLOFF;
  const dx = source[0] - listener[0];
  const dy = source[1] - listener[1];
  const dz = source[2] - listener[2];
  const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const clamped = distance < ref ? ref : (distance > max ? max : distance);
  const gain = ref / (ref + rolloff * (clamped - ref));
  const raw = distance === 0 ? 0 : dx / distance;
  const pan = raw < -1 ? -1 : (raw > 1 ? 1 : raw);
  return { distance, gain, pan };
}
