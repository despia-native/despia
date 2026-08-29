//
//  film.ts - THE FILM TIMELINE (12-marketing-video.md, Phase 0/1).
//
//  A marketing film is a shot list against ONE deterministic timeline, and this module is
//  that timeline as pure math: no DOM, no clock, no network. The driver (cli/film-render.ts)
//  asks "what does the stage look like at t milliseconds" and draws the answer; asking twice
//  returns the same answer, which is what makes frame N of a render equal a still captured at
//  t0 + N/fps - the Phase 0 gate.
//
//  WHAT IT DELIBERATELY DOES NOT DO. It does not resolve semantic camera targets ("#ring") -
//  a target is a MEASURED box, and measuring needs a mounted page, so the driver measures once
//  per scene and hands this module CONCRETE moves. It does not re-implement easing: every
//  interpolation runs through motionProgress, the corpus-pinned curve the three renderers
//  already share (Conformance/motion). A second easing in this codebase would be a bug.
//
//  Corpus: OpenSource/Conformance/film/timeline.json.
//

import { parseMotion, motionProgress, type MotionSpec } from "./motion.ts";

// ── the resolved document ────────────────────────────────────────────────────────────

export type FilmFormat = { width: number; height: number };

export type FilmTheme = {
  bg: string;
  ink: string;
  accent: string;
  /** the caption/text face; empty means the harness default stack */
  font: string;
  /** the color-scheme the app documents mount under - a dark composition over a
   *  light-scheme app renders illegible element ink, so the theme owns this */
  scheme?: "light" | "dark";
};

/** A camera move the DRIVER has already made concrete: symbolic targets are resolved to a
 *  center + scale in STAGE coordinates before the timeline ever sees them. */
export type CameraMove = {
  /** scene-local start, ms */
  atMs: number;
  forMs: number;
  /** stage-space focus center the move ENDS on */
  toX: number;
  toY: number;
  toScale: number;
  ease: MotionSpec;
};

export type CameraState = { x: number; y: number; scale: number };

export type FilmTextRole = "hook" | "benefit" | "title" | "cta";

export type FilmText = {
  role: FilmTextRole;
  text: string;
  /** the one emphasized substring, rendered in the accent ink; empty means none */
  accent: string;
};

export type FilmCaption = { text: string; atMs: number; forMs: number };

export type FilmTap = { atMs: number; target: string };

/** One device POSE keyframe - the cinematic track. Angles in degrees; x/y are offsets as
 *  fractions of the stage (0 = the scene's layout position); scale multiplies the layout
 *  size. The composition law is cameraAt's: hold, then move, each move starting FROM the
 *  held state, eased through the one corpus-pinned curve family. */
export type FilmPoseMove = {
  atMs: number;
  forMs: number;
  to: FilmPoseState;
  ease: MotionSpec;
};

export type FilmPoseState = {
  /** rotateY - the commercial turn */
  turn: number;
  /** rotateX */
  tilt: number;
  /** rotateZ */
  roll: number;
  /** stage-fraction offsets from the scene's layout position */
  x: number;
  y: number;
  scale: number;
};

export const POSE_HOME: FilmPoseState = { turn: 0, tilt: 0, roll: 0, x: 0, y: 0, scale: 1 };

/** One instantaneous state write into the mounted app - attributed to exactly one frame,
 *  like a tap, so the write dispatches once. The value is whatever the store takes. */
export type FilmSet = { atMs: number; name: string; value: unknown };

/** One animated state write: the driver pushes an interpolated value through the app's REAL
 *  store every frame, so a ring count-up or a bar fill is the app rendering its own state,
 *  never an overlay pretending to be the app. The exact `to` is emitted exactly once, on the
 *  first frame at or past the end - after that the store already holds it. */
export type FilmTween = {
  atMs: number;
  forMs: number;
  name: string;
  from: number;
  to: number;
  ease: MotionSpec;
  /** integers only (a calorie counter never shows 736.42) */
  round: boolean;
};

/** One SPOTLIGHT window: everything but the measured target dims, the target gets the
 *  accent ring - "look here" without cutting the interface away. Alpha follows the caption
 *  envelope so the two chrome layers breathe identically. */
export type FilmFocus = { atMs: number; forMs: number; target: string };

/** The HERO transition: the named component travels from where the viewer last saw it in
 *  the OUTGOING scene to where it lives in this one - a component translating into another
 *  view. Runs from the scene's first instant for `forMs`; the driver captures the outgoing
 *  pixels, this module owns only the progress law. */
export type FilmMorph = { target: string; forMs: number; ease: MotionSpec };

/** A SUPPORTING frame: a second device on the stage beside the primary mount. Its screen
 *  is a settled snapshot of its own document+state (the PRIMARY owns every interaction -
 *  taps, writes, camera, morph), and each support floats on its own phase so the frames
 *  drift between each other instead of bobbing in lockstep. `depth` orders it against the
 *  primary (negative = behind) and scales its drift, the near-things-move-more cue. */
export type FilmSupportFrame = {
  document: string;
  /** film <state> preset the snapshot resolves through; empty = document samples */
  state: string;
  /** chassis width as a fraction of stage width */
  width: number;
  /** center position as stage fractions */
  x: number;
  y: number;
  /** -1 (behind the primary) .. 1 (in front); also the drift multiplier */
  depth: number;
};

export type FilmScene = {
  atMs: number;
  forMs: number;
  /** project document to mount; empty for a pure text scene */
  document: string;
  /** name of the film's <state> preset the mount resolves through; empty = document samples */
  state: string;
  /** device framing width as a fraction of stage width (0 = frameless full surface) */
  deviceWidth: number;
  texts: FilmText[];
  captions: FilmCaption[];
  /** symbolic camera rows as AUTHORED - target/zoom pairs the driver makes concrete */
  camera: Array<{ atMs: number; forMs: number; target: string; zoom: number; ease: MotionSpec }>;
  taps: FilmTap[];
  /** the cinematic device track; empty means the device sits at POSE_HOME */
  poses: FilmPoseMove[];
  /** the idle drift: nothing in a commercial is ever static */
  float: boolean;
  /** the backdrop: "none" or a color the glow breathes in */
  glow: string;
  /** how this scene ENTERS: "fade" (the edit crossfade) or "hard" (the commercial cut -
   *  alpha 1 across the boundary; the outgoing scene reads the same law, so a hard-cut
   *  scene also kills its predecessor's fade-out) */
  cut: "fade" | "hard";
  /** the mount chassis: "device" (the phone) or "none" (the component itself on the stage -
   *  the frameless product shot; document scenes only) */
  frame: "device" | "none";
  /** instantaneous state writes into the mounted app */
  sets: FilmSet[];
  /** animated state writes - the app renders every in-between itself */
  tweens: FilmTween[];
  /** spotlight windows over measured components */
  focus: FilmFocus[];
  /** the hero transition into this scene; null means none */
  morph: FilmMorph | null;
  /** supporting frames floating beside the primary mount */
  frames: FilmSupportFrame[];
};

export type FilmStatePreset = {
  name: string;
  vars: { [name: string]: unknown };
  globals: { [name: string]: unknown };
};

export type Film = {
  id: string;
  durationMs: number;
  fps: number;
  format: FilmFormat;
  theme: FilmTheme;
  scenes: FilmScene[];
  states: FilmStatePreset[];
};

// ── validation: refusals, not warnings (the guard posture) ───────────────────────────

export type FilmProblem = { code: string; message: string };

/** The slot ceilings G-overrun enforces. Store preview is the strictest real target. */
export const FILM_SLOT_CEILINGS_MS: { [format: string]: number } = {
  "app-store-preview": 30_000,
};

export function validateFilm(film: Film, slot?: string): FilmProblem[] {
  const out: FilmProblem[] = [];
  if (film.scenes.length === 0) {
    out.push({ code: "empty", message: "a film with no scenes renders nothing" });
  }
  if (film.fps <= 0 || film.durationMs <= 0) {
    out.push({ code: "canvas", message: "fps and duration must be positive" });
  }
  let cursor = 0;
  for (const [i, scene] of film.scenes.entries()) {
    if (scene.atMs !== cursor) {
      out.push({
        code: "gap",
        message: `scene ${i + 1} starts at ${scene.atMs}ms but the previous scene ends at ${cursor}ms - `
          + "the timeline is contiguous, so a gap is a black hole in the advertisement",
      });
    }
    if (scene.forMs <= 0) {
      out.push({ code: "scene-empty", message: `scene ${i + 1} has no duration` });
    }
    if (scene.document === "" && scene.texts.length === 0) {
      out.push({
        code: "static",
        message: `scene ${i + 1} mounts no document and says nothing - `
          + "a scene where nothing happens is the signature bad AI video (G-static)",
      });
    }
    for (const move of scene.camera) {
      if (move.atMs + move.forMs > scene.forMs) {
        out.push({
          code: "camera-overrun",
          message: `scene ${i + 1}: a camera move ends after the scene does`,
        });
      }
    }
    for (const move of scene.poses) {
      if (move.atMs + move.forMs > scene.forMs) {
        out.push({
          code: "pose-overrun",
          message: `scene ${i + 1}: a device pose move ends after the scene does`,
        });
      }
    }
    for (const cap of scene.captions) {
      if (cap.atMs + cap.forMs > scene.forMs) {
        out.push({
          code: "caption-overrun",
          message: `scene ${i + 1}: caption "${cap.text}" outlives its scene`,
        });
      }
    }
    if (scene.frame === "none" && scene.document === "") {
      out.push({
        code: "frame",
        message: `scene ${i + 1}: frame="none" is the frameless PRODUCT shot - it needs a document to be the product of`,
      });
    }
    if (scene.document === "" && (scene.sets.length > 0 || scene.tweens.length > 0)) {
      out.push({
        code: "write-orphan",
        message: `scene ${i + 1}: a state write needs a mounted app to write into`,
      });
    }
    for (const s of scene.sets) {
      if (s.atMs >= scene.forMs) {
        out.push({
          code: "write-overrun",
          message: `scene ${i + 1}: the set of "${s.name}" lands after the scene ends`,
        });
      }
    }
    for (const tw of scene.tweens) {
      if (tw.atMs + tw.forMs > scene.forMs) {
        out.push({
          code: "write-overrun",
          message: `scene ${i + 1}: the tween of "${tw.name}" outlives its scene`,
        });
      }
    }
    if (scene.focus.length > 0 && scene.document === "") {
      out.push({
        code: "focus",
        message: `scene ${i + 1}: a spotlight needs a mounted document to measure its target in`,
      });
    }
    for (const row of scene.focus) {
      if (row.atMs + row.forMs > scene.forMs) {
        out.push({
          code: "focus-overrun",
          message: `scene ${i + 1}: the spotlight on ${row.target} outlives its scene`,
        });
      }
    }
    for (const fr of scene.frames) {
      const reason = scene.document === ""
        ? "a supporting frame supports a primary mount - the scene needs a document"
        : fr.document === ""
          ? "a supporting frame names its own document"
          : !(fr.width > 0 && fr.width <= 1)
            ? "width is a fraction of the stage width in (0, 1]"
            : fr.x < 0 || fr.x > 1 || fr.y < 0 || fr.y > 1
              ? "x/y center the frame in stage fractions [0, 1]"
              : fr.depth < -1 || fr.depth > 1
                ? "depth orders against the primary in [-1, 1]"
                : null;
      if (reason !== null) {
        out.push({ code: "support-frame", message: `scene ${i + 1}: ${reason}` });
      }
    }
    if (scene.morph !== null) {
      if (i === 0 || scene.document === "") {
        out.push({
          code: "morph",
          message: `scene ${i + 1}: a morph carries a component FROM the previous scene INTO this one's `
            + "document - it needs both",
        });
      }
      if (scene.morph.forMs > scene.forMs) {
        out.push({
          code: "morph-overrun",
          message: `scene ${i + 1}: the morph outlives its scene`,
        });
      }
    }
    cursor = scene.atMs + scene.forMs;
  }
  if (film.scenes.length > 0 && cursor !== film.durationMs) {
    out.push({
      code: "duration",
      message: `the scenes end at ${cursor}ms but the film declares ${film.durationMs}ms - `
        + "the declaration is the contract the encoder and the store slot hold you to",
    });
  }
  const ceiling = slot === undefined ? undefined : FILM_SLOT_CEILINGS_MS[slot];
  if (ceiling !== undefined && film.durationMs > ceiling) {
    out.push({
      code: "overrun",
      message: `${film.durationMs}ms exceeds the ${slot} ceiling of ${ceiling}ms (G-overrun) - `
        + "refused at author time, not at upload",
    });
  }
  return out;
}

// ── the camera track: concrete moves in, a state per instant out ─────────────────────

/** The neutral camera: unscaled, centered on the stage midpoint the driver declares. */
export function cameraAt(
  moves: ReadonlyArray<CameraMove>, tMs: number, home: CameraState,
): CameraState {
  let state: CameraState = { ...home };
  for (const move of moves) {
    if (tMs < move.atMs) break;
    const from = state;
    const to = { x: move.toX, y: move.toY, scale: move.toScale };
    if (tMs >= move.atMs + move.forMs) {
      state = to;
      continue;
    }
    const p = motionProgress(move.ease, tMs - move.atMs);
    state = {
      x: from.x + (to.x - from.x) * p,
      y: from.y + (to.y - from.y) * p,
      scale: from.scale + (to.scale - from.scale) * p,
    };
    break;
  }
  return state;
}

/** The pose track: cameraAt's hold-then-move law over six axes. A move interpolates every
 *  axis from the HELD state, so a turn that follows a tilt starts from the tilted pose. */
export function poseAt(
  moves: ReadonlyArray<FilmPoseMove>, tMs: number, home: FilmPoseState = POSE_HOME,
): FilmPoseState {
  let state: FilmPoseState = { ...home };
  for (const move of moves) {
    if (tMs < move.atMs) break;
    if (tMs >= move.atMs + move.forMs) {
      state = { ...move.to };
      continue;
    }
    const p = motionProgress(move.ease, tMs - move.atMs);
    const from = state;
    state = {
      turn: from.turn + (move.to.turn - from.turn) * p,
      tilt: from.tilt + (move.to.tilt - from.tilt) * p,
      roll: from.roll + (move.to.roll - from.roll) * p,
      x: from.x + (move.to.x - from.x) * p,
      y: from.y + (move.to.y - from.y) * p,
      scale: from.scale + (move.to.scale - from.scale) * p,
    };
    break;
  }
  return state;
}

/** The idle float: a deterministic drift added ON TOP of the pose, because in a commercial
 *  nothing is ever static - a device that holds perfectly still for a second reads as a
 *  freeze-frame. Two incommensurate periods so the loop never visibly repeats inside a take.
 *  Amplitudes are deliberately small: the float is felt, not seen. */
export const FLOAT_Y_FRACTION = 0.004;
export const FLOAT_TURN_DEG = 1.6;
export const FLOAT_TILT_DEG = 0.9;
export function floatAt(tMs: number): { y: number; turn: number; tilt: number } {
  const t = tMs / 1000;
  return {
    y: FLOAT_Y_FRACTION * Math.sin(2 * Math.PI * t / 5.3),
    turn: FLOAT_TURN_DEG * Math.sin(2 * Math.PI * t / 7.1),
    tilt: FLOAT_TILT_DEG * Math.sin(2 * Math.PI * t / 6.2 + 1.0),
  };
}

// ── the frame: everything the driver draws at one instant ────────────────────────────

/** Scene enter/leave crossfade. A cut between two mounted documents with no transition
 *  reads as a glitch at 30fps; a fixed short fade reads as an edit. */
export const SCENE_FADE_MS = 320;

export type CaptionFrame = { text: string; alpha: number; rise: number };

export type SceneFrame = {
  index: number;
  /** scene-local elapsed ms */
  tMs: number;
  /** 0..1 opacity of the whole scene layer (enter/leave fade) */
  alpha: number;
  captions: CaptionFrame[];
  /** taps whose instant falls inside THIS frame's window [tMs, tMs + frameMs) */
  taps: FilmTap[];
  /** text overlays with their entrance progress 0..1 */
  texts: Array<{ role: FilmTextRole; text: string; accent: string; enter: number }>;
  /** state writes due THIS frame: due sets (single-frame, like taps) then live tween
   *  samples, in that order, so a set and a tween of one name resolve author-visibly */
  writes: Array<{ name: string; value: unknown }>;
  /** the active spotlight (the LAST row whose window holds this instant), with its
   *  caption-envelope alpha; null when nothing is spotlit */
  focus: { target: string; alpha: number } | null;
  /** the hero transition's eased progress while it runs; null before/without/after */
  morph: { target: string; p: number } | null;
};

const TEXT_ENTER = parseMotion("easeOut", "0.45");
const CAPTION_ENTER = parseMotion("easeOut", "0.3");

export function sceneIndexAt(film: Film, tMs: number): number {
  for (let i = film.scenes.length - 1; i >= 0; i--) {
    const s = film.scenes[i]!;
    if (tMs >= s.atMs) return i;
  }
  return 0;
}

/** The pure frame function. `frameMs` is the frame period (1000/fps); taps are attributed to
 *  exactly one frame so a click dispatches once, never zero or twice. */
export function filmFrameAt(film: Film, tMs: number, frameMs: number): SceneFrame {
  const index = sceneIndexAt(film, tMs);
  const scene = film.scenes[index]!;
  const local = tMs - scene.atMs;

  // THE CUT LAW: a scene's own cut owns its ENTER edge, and the NEXT scene's cut owns this
  // scene's LEAVE edge - a hard cut is one boundary, so both sides of it must agree, and
  // making the incoming scene the owner means one word in one place cuts the whole edit.
  // A MORPH implies the hard boundary: the hero transition IS the edit, and a crossfade
  // veil playing over its first 320ms would dim the very layers the morph exists to show.
  const hardIn = scene.cut === "hard" || scene.morph !== null;
  const enter = index === 0 || hardIn ? 1 : Math.min(local / SCENE_FADE_MS, 1);
  const untilEnd = scene.atMs + scene.forMs - tMs;
  const next = film.scenes[index + 1];
  const leave = next === undefined || next.cut === "hard" || next.morph !== null
    ? 1
    : Math.min(Math.max(untilEnd / SCENE_FADE_MS, 0), 1);
  const alpha = Math.min(enter, leave);

  const captions: CaptionFrame[] = [];
  for (const cap of scene.captions) {
    const ct = local - cap.atMs;
    if (ct < 0 || ct >= cap.forMs) continue;
    const inP = motionProgress(CAPTION_ENTER, ct);
    const outP = Math.min(Math.max((cap.forMs - ct) / 240, 0), 1);
    captions.push({ text: cap.text, alpha: Math.min(inP, outP), rise: 1 - inP });
  }

  const taps = scene.taps.filter((tap) => tap.atMs >= local && tap.atMs < local + frameMs);

  const texts = scene.texts.map((t) => ({
    role: t.role, text: t.text, accent: t.accent,
    enter: motionProgress(TEXT_ENTER, local),
  }));

  const writes: Array<{ name: string; value: unknown }> = [];
  for (const s of scene.sets) {
    if (s.atMs >= local && s.atMs < local + frameMs) writes.push({ name: s.name, value: s.value });
  }
  for (const tw of scene.tweens) {
    if (local < tw.atMs) continue;
    // active through the first frame AT or PAST the end - that frame emits the exact `to`
    // (never the eased approximation of it), and no frame after it writes again
    if (local - frameMs >= tw.atMs + tw.forMs) continue;
    const value = local >= tw.atMs + tw.forMs
      ? tw.to
      : tw.from + (tw.to - tw.from) * motionProgress(tw.ease, local - tw.atMs);
    writes.push({ name: tw.name, value: tw.round ? Math.round(value) : value });
  }

  let focus: SceneFrame["focus"] = null;
  for (const row of scene.focus) {
    const ft = local - row.atMs;
    if (ft < 0 || ft >= row.forMs) continue;
    const inP = motionProgress(CAPTION_ENTER, ft);
    const outP = Math.min(Math.max((row.forMs - ft) / 240, 0), 1);
    focus = { target: row.target, alpha: Math.min(inP, outP) };
  }

  const morph = scene.morph !== null && local < scene.morph.forMs
    ? { target: scene.morph.target, p: motionProgress(scene.morph.ease, local) }
    : null;

  return { index, tMs: local, alpha, captions, taps, texts, writes, focus, morph };
}

/** Total frame count for the declared canvas: the last frame lands strictly inside the
 *  duration, so a 2s film at 30fps is exactly 60 frames, never 61. */
export function filmFrameCount(film: Film): number {
  return Math.round(film.durationMs * film.fps / 1000);
}
