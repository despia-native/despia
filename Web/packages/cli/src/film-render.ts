//
//  film-render.ts - THE FILM DRIVER (12-marketing-video.md, Phase 0/2).
//
//  A film render is the shot pipeline run once per frame: the same registry, the same scope
//  ladder, the same settle law, the same egress belt - plus a paused clock that is ADVANCED
//  by exactly one frame period between captures. That is the whole determinism story:
//
//    clock.pauseAt(sceneStart)  ->  capture  ->  clock.runFor(frameMs)  ->  capture  ...
//
//  Two renders take different wall time to mount and settle, but the app never sees wall
//  time - it sees the pinned instant plus N exact frame periods, so frame N is the same
//  pixels in both. The Phase 0 gate ("byte-identical twice; frame N equals a still at
//  t0 + N/fps") is a consequence of this loop, not an aspiration.
//
//  THE STAGE. Each scene renders on its own page: theme ground, an optional device chassis
//  (the same transparent-window art the screenshot templates use) with the REAL app mounted
//  in its window, a camera transform on the world, and a chrome layer (captions, text
//  overlays, the cursor) that deliberately does NOT scale with the camera - a caption that
//  zooms with the phone is a caption glued to the wrong layer. Scene transitions are a fade
//  through the ground colour: with one page per scene a true crossfade would need
//  compositing two pages, and a fade-through-brand reads as an edit, which is all a cut
//  needs to read as.
//
//  SEMANTIC CAMERA TARGETS. "#calorieRing" is measured in the mounted page at the neutral
//  camera, once per scene, and only then handed to the kernel as a concrete move - the
//  kernel stays pure, and a layout change moves the camera instead of breaking the shot.
//
//  THE ENCODE IS TWO-TIER, by measurement (Annex A): the pinned Chromium encodes VP9 but not
//  H.264, so the zero-install PREVIEW tier is WebCodecs -> our own WebM writer (webm.ts) on
//  a secure origin (this is why the film origin is https where the shot origin is http).
//  The MASTER tier shells out to FFmpeg when it exists; `doctor` reports its absence.
//

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  cameraAt, filmFrameAt, filmFrameCount, floatAt, poseAt, validateFilm, POSE_HOME,
  type CameraMove, type CameraState, type Film, type FilmProblem, type FilmScene,
} from "@despia/kernel/film";

import type { ProjectConfig } from "./config.ts";
import { planShot, buildProjectRegistry, resolveDocument, type ShotProfile } from "./shot.ts";
import {
  bundleHarness, bundledFaceCss, waitForSettle, contentTypeFor, safeProjectPath,
  type ShotPage,
} from "./shot-render.ts";
import { muxWebm, type WebmFrame } from "./webm.ts";

// https, not http: WebCodecs exists only in a secure context, and route interception
// fulfills the request before TLS is ever attempted, so no certificate is involved.
const FILM_ORIGIN = "https://dsx-film.local";

// The device art the screenshot templates already ship: a transparent screen window inside
// real chassis geometry. The window insets are ShotFrame's own measured numbers, and the
// window's aspect is exactly 440:956 - which is why the app mounts at 440x956 logical and
// scales to fit with no letterbox arithmetic.
const DEVICE_ART = "device-ios.png";
const WINDOW = { top: 0.02860, left: 0.05823, width: 0.88353, height: 0.94280 };
const ART_ASPECT = 498 / 1014;
const APP_LOGICAL = { width: 440, height: 956 };

type FilmContext = {
  newPage(): Promise<ShotPage>;
  close(): Promise<void>;
  clock: {
    install(o: { time: Date }): Promise<void>;
    pauseAt(t: Date): Promise<void>;
    runFor(ms: number): Promise<void>;
  };
  addInitScript(s: { content: string }): Promise<void>;
};
type FilmBrowser = { newContext(o: unknown): Promise<FilmContext> };

export type FilmRenderOptions = {
  webRoot: string;
  projectRoot: string;
  outDir: string;
  /** "webm" (WebCodecs preview, zero install) | "mp4" (FFmpeg master) | "auto" */
  encoder?: "webm" | "mp4" | "auto";
  /** capture only frames [0, limit) - the check/test path, where 12 frames prove the loop */
  frameLimit?: number;
  onProgress?: (frame: number, total: number) => void;
};

export type FilmOutcome = {
  ok: boolean;
  problems: FilmProblem[];
  errors: string[];
  videoPath: string | null;
  frameCount: number;
  /** sha256 per captured frame - the determinism gate compares two runs of these */
  frameHashes: string[];
};

export function ffmpegAvailable(): boolean {
  return spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;
}

/** Clamp a measured rect to the stage. A degenerate result (zero or negative span) means
 *  the subject lies outside the visible stage; the caller must refuse rather than let a
 *  clipped screenshot throw mid-render. */
function stageClip(
  format: { width: number; height: number },
  r: { x: number; y: number; w: number; h: number },
): { x: number; y: number; width: number; height: number } {
  const x = Math.max(0, r.x);
  const y = Math.max(0, r.y);
  return {
    x, y,
    width: Math.min(r.w - (x - r.x), format.width - x),
    height: Math.min(r.h - (y - r.y), format.height - y),
  };
}

/** CAPTURE UNTIL STABLE - the shot pipeline's settle law applied to pixels. The compositor
 *  re-rasters transformed layers asynchronously, and whether one capture lands before or
 *  after that re-raster is timing-dependent. The SETTLED raster for a paused frame is
 *  unique, so the first capture that equals its predecessor is the same bytes in every run.
 *  Nearly every frame stabilizes on the second capture; the bound is a backstop, and a
 *  frame that somehow never settled would still be caught by the hash gate. */
async function stableScreenshot(
  page: { screenshot(o: unknown): Promise<Buffer> },
  prepare?: () => Promise<unknown>,
): Promise<Buffer> {
  if (prepare !== undefined) await prepare();
  let png = await page.screenshot({ type: "png" });
  for (let attempt = 0; attempt < 5; attempt++) {
    if (prepare !== undefined) await prepare();
    const again = await page.screenshot({ type: "png" });
    const same = again.equals(png);
    png = again;
    if (same) break;
  }
  return png;
}

// ── the stage page ───────────────────────────────────────────────────────────────────

function stageHtml(film: Film): string {
  const { width, height } = film.format;
  const face = film.theme.font !== "" ? `${film.theme.font}, ` : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Film</title><link rel="icon" href="data:,">
<style>
  html, body { margin: 0; width: ${width}px; height: ${height}px; overflow: hidden; }
  body { background: ${film.theme.bg};
         font-family: ${face}-apple-system, "SF Pro Display", "Segoe UI", Roboto, sans-serif; }
  #veil { position: absolute; inset: 0; background: ${film.theme.bg}; z-index: 40;
          opacity: 0; pointer-events: none; }
  #world, #far, #near { position: absolute; left: 0; top: 0;
                        width: ${width}px; height: ${height}px; transform-origin: 0 0; }
  #near { z-index: 25; pointer-events: none; }
  #vignette { position: absolute; inset: 0; z-index: 28; pointer-events: none;
              background: radial-gradient(130% 90% at 50% 42%,
                transparent 58%, rgba(0, 0, 0, 0.45) 100%); }
  #chrome { position: absolute; inset: 0; z-index: 30; pointer-events: none; }
  #glow { position: absolute; inset: -20%; }
  #floor-sheen { position: absolute; left: -10%; right: -10%; bottom: -5%; height: 34%;
                 background: linear-gradient(to top, rgba(255, 255, 255, 0.05), transparent); }
  .film-bokeh { position: absolute; border-radius: 50%; }
  .film-device-rig { position: absolute; }
  .film-reflect { position: absolute; inset: 0; perspective: 1600px; }
  .film-device { position: absolute; inset: 0; transform-style: preserve-3d; }
  .film-device img { position: absolute; inset: 0; width: 100%; height: 100%; z-index: 2; }
  .film-window { position: absolute; overflow: hidden; background: #000; }
  .film-shine { position: absolute; inset: 0; z-index: 3; pointer-events: none;
                mix-blend-mode: screen; }
  .film-chassis { position: absolute; inset: 0; border-radius: 13% / 6.4%;
                  background: linear-gradient(180deg, #262b33, #14171c 14%, #101318 86%, #232830); }
  #spotlight { position: absolute; border-radius: 18px;
               border: 2px solid color-mix(in srgb, ${film.theme.accent} 55%, transparent);
               /* the glow is listed FIRST: earlier shadows paint on top, and a glow listed
                  after the 4000px scrim would be dimmed through it instead of sitting on it */
               box-shadow: 0 0 44px color-mix(in srgb, ${film.theme.accent} 30%, transparent),
                           0 0 0 4000px rgba(5, 8, 12, 0.55);
               opacity: 0; pointer-events: none; }
  #morph-backplate { position: absolute; left: 0; top: 0; width: ${width}px;
                     height: ${height}px; pointer-events: none; }
  /* the flight box and its shadow take their border-radius PER FRAME - the exact
     interpolated curve of the two measured cards, never a fixed guess */
  #morph-box { position: absolute; opacity: 0; pointer-events: none; overflow: hidden; }
  #morph-shadow { position: absolute; pointer-events: none; opacity: 0;
                  box-shadow: 0 28px 72px rgba(0, 0, 0, 0.55), 0 8px 24px rgba(0, 0, 0, 0.4); }
  /* the SURFACES stretch to the box's interpolated aspect on purpose: they are TEXT-FREE
     card faces (every piece is hidden before these crops are taken), and squashing a flat
     face is invisible - the pieces themselves ride above at their own exact rects. */
  #morph-box img { position: absolute; top: 0; left: 0; width: 100%; height: 100%; }
  #morph-pieces { position: absolute; inset: 0; pointer-events: none; }
  .morph-piece { position: absolute; }
  .morph-piece img { position: absolute; inset: 0; width: 100%; height: 100%; }
  .film-shadow { position: absolute; z-index: 0; border-radius: 50%;
                 background: radial-gradient(closest-side, rgba(0,0,0,0.55), rgba(0,0,0,0)); }
  #app { position: absolute; left: 0; top: 0;
         width: ${APP_LOGICAL.width}px; height: ${APP_LOGICAL.height}px;
         transform-origin: 0 0; }
  .film-text { position: absolute; inset: 0; display: flex; flex-direction: column;
               align-items: center; justify-content: center; gap: ${Math.round(height * 0.02)}px;
               padding: 0 ${Math.round(width * 0.1)}px; text-align: center; }
  .film-text-hook, .film-text-title { color: ${film.theme.ink}; font-weight: 800;
      font-size: ${Math.round(width * 0.105)}px; line-height: 1.06; letter-spacing: -0.03em; }
  .film-text-benefit { color: color-mix(in srgb, ${film.theme.ink} 82%, transparent);
      font-weight: 600;
      font-size: ${Math.round(width * 0.058)}px; line-height: 1.18; letter-spacing: -0.015em; }
  .film-text-cta { color: ${film.theme.bg}; background: ${film.theme.accent}; font-weight: 800;
      font-size: ${Math.round(width * 0.045)}px; padding: 0.55em 1.3em; border-radius: 999px;
      box-shadow: 0 14px 44px color-mix(in srgb, ${film.theme.accent} 35%, transparent); }
  .film-accent { color: ${film.theme.accent}; }
  #caption { position: absolute; left: 8%; right: 8%; bottom: ${Math.round(height * 0.042)}px;
             display: flex; justify-content: center; opacity: 0; }
  #caption span { color: ${film.theme.ink}; background: rgba(8, 10, 14, 0.62);
                  border: 1px solid rgba(255, 255, 255, 0.09);
                  font-weight: 600; font-size: ${Math.round(width * 0.036)}px;
                  letter-spacing: 0.01em;
                  padding: 0.62em 1.5em; border-radius: 999px; backdrop-filter: blur(6px);
                  text-align: center; }
  #cursor { position: absolute; width: 50px; height: 50px; margin: -25px 0 0 -25px;
            border-radius: 50%; background: rgba(255,255,255,0.5);
            box-shadow: 0 0 0 1.5px rgba(255,255,255,0.75), 0 6px 18px rgba(0,0,0,0.35);
            opacity: 0; z-index: 35; }
  #tapring { position: absolute; width: 50px; height: 50px; margin: -25px 0 0 -25px;
             border-radius: 50%; border: 2px solid rgba(255,255,255,0.8);
             opacity: 0; z-index: 34; }
</style></head>
<body>
  <div id="far"></div>
  <div id="world"></div>
  <div id="near"></div>
  <div id="vignette"></div>
  <div id="chrome">
    <div id="spotlight"></div>
    <div id="caption"><span></span></div>
    <div id="tapring"></div>
    <div id="cursor"></div>
  </div>
  <div id="veil"></div>
</body></html>`;
}

/** Build the scene's static DOM. Runs in the page - a SERIALIZED function, so every value
 *  it needs (the window insets included) travels in the argument; it can close over nothing. */
type SceneSetupArg = {
  texts: Array<{ role: string; text: string; accent: string }>;
  device: { x: number; y: number; width: number; height: number } | null;
  /** the frameless product shot: the component itself, no chassis; height is intrinsic and
   *  measured after settle (FRAMELESS_PLACE), so setup only knows the mount width */
  frameless: { width: number } | null;
  window: { top: number; left: number; width: number; height: number };
  appWidth: number;
  art: string;
  glow: string;
  stage: { width: number; height: number };
  /** the atmosphere: fixed bokeh seeds split across the parallax planes */
  bokeh: Array<{ x: number; y: number; s: number; o: number; layer: string }>;
  /** the -webkit-box-reflect value for the floor mirror */
  reflectMask: string;
  /** supporting frames: settled screen snapshots placed as depth-ordered device rigs */
  supports: Array<{ x: number; y: number; width: number; depth: number; screenB64: string }>;
  /** the chassis art's width/height ratio, for sizing a support rig from its width */
  artAspect: number;
};

/** The ATMOSPHERE seeds - a fixed table, never a RNG, because a particle field that moves
 *  between runs is noise in a deterministic frame. Positions/sizes are stage fractions;
 *  opacities stay low on purpose: depth is felt, never counted. */
const BOKEH: SceneSetupArg["bokeh"] = [
  { x: 0.12, y: 0.16, s: 0.11, o: 0.05, layer: "far" },
  { x: 0.82, y: 0.10, s: 0.07, o: 0.04, layer: "far" },
  { x: 0.68, y: 0.32, s: 0.14, o: 0.05, layer: "far" },
  { x: 0.22, y: 0.55, s: 0.08, o: 0.04, layer: "far" },
  { x: 0.90, y: 0.60, s: 0.12, o: 0.05, layer: "far" },
  { x: 0.05, y: 0.80, s: 0.09, o: 0.04, layer: "far" },
  { x: 0.55, y: 0.07, s: 0.05, o: 0.06, layer: "near" },
  { x: 0.13, y: 0.36, s: 0.06, o: 0.05, layer: "near" },
  { x: 0.89, y: 0.42, s: 0.05, o: 0.06, layer: "near" },
  { x: 0.30, y: 0.88, s: 0.07, o: 0.05, layer: "near" },
  { x: 0.76, y: 0.80, s: 0.05, o: 0.05, layer: "near" },
];

/** The studio floor: a live mirror of the finished rig render (pose, screen and all),
 *  fading fast - the one cue that tells the eye there is a ground plane under the object. */
const REFLECT_MASK =
  "below 14px linear-gradient(to bottom, transparent 52%, rgba(0, 0, 0, 0.16) 100%)";
const SCENE_SETUP = (cfg: SceneSetupArg): void => {
  const world = document.getElementById("world")!;
  const far = document.getElementById("far")!;
  const near = document.getElementById("near")!;
  world.innerHTML = "";
  far.innerHTML = "";
  near.innerHTML = "";
  if (cfg.texts.length > 0) {
    const wrap = document.createElement("div");
    wrap.className = "film-text";
    wrap.style.zIndex = "1";
    for (const t of cfg.texts) {
      const el = document.createElement("div");
      el.className = "film-text-" + t.role;
      el.dataset["role"] = t.role;
      if (t.accent !== "" && t.text.includes(t.accent)) {
        // emphasize the FIRST occurrence and keep the whole tail - split(sep, 2) would
        // silently truncate everything after a second occurrence of the accent
        const at = t.text.indexOf(t.accent);
        el.append(t.text.slice(0, at));
        const em = document.createElement("span");
        em.className = "film-accent";
        em.textContent = t.accent;
        el.append(em);
        el.append(t.text.slice(at + t.accent.length));
      } else {
        el.textContent = t.text;
      }
      wrap.append(el);
    }
    world.append(wrap);
  }
  if (cfg.glow !== "none") {
    const glow = document.createElement("div");
    glow.id = "glow";
    glow.style.background =
      `radial-gradient(42% 30% at 50% 38%, ${cfg.glow}2e 0%, transparent 70%)`;
    far.append(glow);
    const sheen = document.createElement("div");
    sheen.id = "floor-sheen";
    far.append(sheen);
    for (const b of cfg.bokeh) {
      const dot = document.createElement("div");
      dot.className = "film-bokeh";
      dot.style.left = `${b.x * cfg.stage.width}px`;
      dot.style.top = `${b.y * cfg.stage.height}px`;
      dot.style.width = `${b.s * cfg.stage.width}px`;
      dot.style.height = `${b.s * cfg.stage.width}px`;
      dot.style.background = `radial-gradient(circle, ${cfg.glow} 0%, color-mix(in srgb, ${cfg.glow} 45%, transparent) 30%, transparent 62%)`;
      dot.style.opacity = String(b.o);
      (b.layer === "far" ? far : near).append(dot);
    }
  }
  // SUPPORTING frames first: each is the same rig anatomy as the primary (chassis slices,
  // window, art, reflection, floor shadow) with a settled SNAPSHOT for a screen - the
  // primary owns every interaction, so a static screen is behaviorally identical and one
  // live app per page keeps the mount law simple. Depth orders them around the primary.
  for (const [i, s] of cfg.supports.entries()) {
    const w = s.width;
    const h = w / (cfg.artAspect);
    const rig = document.createElement("div");
    rig.className = "film-device-rig";
    rig.style.left = `${s.x * cfg.stage.width - w / 2}px`;
    rig.style.top = `${s.y * cfg.stage.height - h / 2}px`;
    rig.style.width = `${w}px`;
    rig.style.height = `${h}px`;
    rig.style.zIndex = s.depth < 0 ? "2" : "4";
    const shadow = document.createElement("div");
    shadow.className = "film-shadow";
    shadow.style.left = `${w * 0.1}px`;
    shadow.style.top = `${h * 0.985}px`;
    shadow.style.width = `${w * 0.8}px`;
    shadow.style.height = `${w * 0.13}px`;
    shadow.style.filter = "blur(14px)";
    shadow.style.opacity = "0.42";
    rig.append(shadow);
    const box = document.createElement("div");
    box.className = "film-device";
    box.id = `support-pose-${i}`;
    const depth = w * 0.05;
    const SLICES = Math.max(24, Math.round(depth));
    for (let j = SLICES; j >= 1; j--) {
      const slice = document.createElement("div");
      slice.className = "film-chassis";
      slice.style.transform = `translateZ(${-(depth * j / SLICES)}px)`;
      box.append(slice);
    }
    const win = document.createElement("div");
    win.className = "film-window";
    win.style.left = `${w * cfg.window.left}px`;
    win.style.top = `${h * cfg.window.top}px`;
    win.style.width = `${w * cfg.window.width}px`;
    win.style.height = `${h * cfg.window.height}px`;
    win.style.borderRadius = `${w * 0.052}px`;
    const screen = document.createElement("img");
    screen.src = "data:image/png;base64," + s.screenB64;
    screen.style.position = "absolute";
    screen.style.inset = "0";
    screen.style.width = "100%";
    screen.style.height = "100%";
    win.append(screen);
    const art = document.createElement("img");
    art.src = "/" + cfg.art;
    box.append(win, art);
    const reflect = document.createElement("div");
    reflect.className = "film-reflect";
    reflect.style.setProperty("-webkit-box-reflect", cfg.reflectMask);
    reflect.append(box);
    rig.append(reflect);
    world.append(rig);
  }
  if (cfg.device !== null) {
    const d = cfg.device;
    // the RIG holds layout; the REFLECT wrap holds perspective + the floor mirror; the
    // DEVICE inside takes the pose transform, so the pose never fights the layout box and
    // the reflection mirrors the FINISHED render (pose, screen and all)
    const rig = document.createElement("div");
    rig.className = "film-device-rig";
    rig.style.left = `${d.x}px`; rig.style.top = `${d.y}px`;
    rig.style.width = `${d.width}px`; rig.style.height = `${d.height}px`;
    rig.style.zIndex = "3";
    const shadow = document.createElement("div");
    shadow.className = "film-shadow";
    shadow.id = "floor-shadow";
    shadow.style.left = `${d.width * 0.1}px`;
    shadow.style.top = `${d.height * 0.985}px`;
    shadow.style.width = `${d.width * 0.8}px`;
    shadow.style.height = `${d.width * 0.13}px`;
    shadow.style.filter = "blur(18px)";
    rig.append(shadow);
    const box = document.createElement("div");
    box.className = "film-device";
    box.id = "device-pose";
    // REAL depth: the chassis is extruded as stacked rounded-rect slices along -Z (the
    // classic CSS trick for a rounded solid - a single side wall cannot follow a rounded
    // silhouette, a dense stack of slices can). preserve-3d depth-sorts them, so a turned
    // device shows an actual edge with thickness instead of a rotated card. The stack is
    // DENSE on purpose: at ~1px Z-steps the edge is a surface; at 4px it is a staircase.
    const depth = d.width * 0.05;
    const SLICES = Math.max(24, Math.round(depth));
    for (let i = SLICES; i >= 1; i--) {
      const slice = document.createElement("div");
      slice.className = "film-chassis";
      slice.style.transform = `translateZ(${-(depth * i / SLICES)}px)`;
      box.append(slice);
    }
    const win = document.createElement("div");
    win.className = "film-window";
    win.style.left = `${d.width * cfg.window.left}px`;
    win.style.top = `${d.height * cfg.window.top}px`;
    win.style.width = `${d.width * cfg.window.width}px`;
    win.style.height = `${d.height * cfg.window.height}px`;
    win.style.borderRadius = `${d.width * 0.052}px`;
    const app = document.createElement("div");
    app.id = "app";
    app.style.transform = `scale(${d.width * cfg.window.width / cfg.appWidth})`;
    win.append(app);
    const art = document.createElement("img");
    art.src = "/" + cfg.art;
    const shine = document.createElement("div");
    shine.className = "film-shine";
    shine.id = "device-shine";
    box.append(win, art, shine);
    const reflect = document.createElement("div");
    reflect.className = "film-reflect";
    reflect.style.setProperty("-webkit-box-reflect", cfg.reflectMask);
    reflect.append(box);
    rig.append(reflect);
    world.append(rig);
  }
  if (cfg.frameless !== null) {
    const w = cfg.frameless.width;
    // same rig/reflect/pose split as the device; the rig gets its real top/height only
    // after the component has laid out (FRAMELESS_PLACE) - until then a stage-height
    // placeholder, and the reflection is armed by FRAMELESS_PLACE once the height is real
    const rig = document.createElement("div");
    rig.className = "film-device-rig";
    rig.id = "frameless-rig";
    rig.style.zIndex = "3";
    rig.style.left = `${(cfg.stage.width - w) / 2}px`;
    rig.style.top = "0px";
    rig.style.width = `${w}px`;
    rig.style.height = `${cfg.stage.height}px`;
    const shadow = document.createElement("div");
    shadow.className = "film-shadow";
    shadow.id = "floor-shadow";
    rig.append(shadow);
    const box = document.createElement("div");
    box.className = "film-device";
    box.id = "device-pose";
    const app = document.createElement("div");
    app.id = "app";
    app.style.height = "auto";
    app.style.transform = `scale(${w / cfg.appWidth})`;
    box.append(app);
    const reflect = document.createElement("div");
    reflect.className = "film-reflect";
    reflect.id = "frameless-reflect";
    reflect.append(box);
    rig.append(reflect);
    world.append(rig);
  }
};

/** Give the settled frameless component its real geometry: the height is INTRINSIC (the
 *  component hugs its content - the DSX default is the law here too), so it exists only
 *  after mount + settle. Returns the placed box for the camera home and the cursor math. */
const FRAMELESS_PLACE = (cfg: { stage: { width: number; height: number }; appWidth: number;
                                reflectMask: string }):
  { x: number; y: number; w: number; h: number } => {
  const rig = document.getElementById("frameless-rig")!;
  const app = document.getElementById("app")!;
  // the app shell mounts a fill-the-viewport frame (.dsx-frame is absolute inset 0), which
  // contributes nothing to an auto height - take it into flow so the component's own hug
  // decides the height, which is the whole point of the frameless shot
  for (const frame of Array.from(app.querySelectorAll(".dsx-frame"))) {
    (frame as HTMLElement).style.position = "relative";
    (frame as HTMLElement).style.inset = "auto";
    // the stage owns the ground in a frameless shot: the shell's own background would
    // otherwise paint the component's box as a slab (visible whenever the component is
    // hidden or translucent - a morph hides it while the crop travels)
    (frame as HTMLElement).style.background = "transparent";
  }
  app.style.background = "transparent";
  const w = rig.getBoundingClientRect().width;
  const scale = w / cfg.appWidth;
  const h = app.offsetHeight * scale;
  const x = (cfg.stage.width - w) / 2;
  const y = (cfg.stage.height - h) * 0.45;
  rig.style.top = `${y}px`;
  rig.style.height = `${h}px`;
  const shadow = document.getElementById("floor-shadow")!;
  shadow.style.left = `${w * 0.06}px`;
  shadow.style.top = `${h * 1.02}px`;
  shadow.style.width = `${w * 0.88}px`;
  shadow.style.height = `${w * 0.1}px`;
  shadow.style.filter = "blur(16px)";
  // the floor mirror arms only now: reflecting the stage-height placeholder would mirror
  // an empty wall, so the reflection waits for the component's real height
  document.getElementById("frameless-reflect")
    ?.style.setProperty("-webkit-box-reflect", cfg.reflectMask);
  return { x, y, w, h };
};

/** The PIECES of a morphing component - the units matched geometry actually moves. A piece
 *  is an element carrying its own DIRECT text (a title, a value) or a childless visual
 *  leaf (a status dot, a bar fill). ONE function serves measuring, hiding and restoring on
 *  BOTH sides of the boundary, so the two scenes cannot disagree about what a piece is;
 *  document order is the identity order-paired matching relies on. Runs in the page. */
const MORPH_PIECES_OP = (arg: { sel: string; op: "measure" | "hide" | "restore";
                                only?: number }):
  Array<{ key: string; x: number; y: number; w: number; h: number }> | null => {
  const root = document.querySelector(arg.sel) as HTMLElement | null;
  if (root === null) return null;
  const kept: Array<{ el: HTMLElement; key: string }> = [];
  // the ROOT is a candidate too - a morph target that is itself a text-bearing leaf has
  // no descendants to walk, and its text must still become a piece or it would stay baked
  // into the "text-free" surface crops. NO silent cap: an unhidden piece is a baked one.
  for (const node of [root, ...Array.from(root.querySelectorAll("*"))]) {
    const el = node as HTMLElement;
    const r = el.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) continue;
    const direct = Array.from(el.childNodes).some(
      (n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? "").trim() !== "");
    if (direct) { kept.push({ el, key: (el.textContent ?? "").trim() }); continue; }
    if (el !== root && el.children.length === 0 && (el.textContent ?? "").trim() === "") {
      kept.push({ el, key: "" });
    }
  }
  // hide/restore preserve any inline visibility the APP itself set: hide stashes the
  // prior value, restore puts back exactly that - never a blanket "" over authored state
  const rows = arg.only === undefined ? kept : kept.filter((_, i) => i === arg.only);
  // hide/restore preserve any inline visibility the APP itself set, and suppress the
  // element's own transitions while the rig toggles it: the capture's DOM writes are
  // scaffolding, not motion, and an app transitioning `all` would otherwise animate a
  // piece back into the surface crop it is supposed to be absent from
  if (arg.op === "hide") {
    for (const row of rows) {
      if (row.el.dataset["dsxMorphVis"] === undefined) {
        row.el.dataset["dsxMorphVis"] = row.el.style.visibility;
        row.el.dataset["dsxMorphTrans"] = row.el.style.transition;
      }
      row.el.style.transition = "none";
      row.el.style.visibility = "hidden";
    }
  }
  if (arg.op === "restore") {
    for (const row of rows) {
      row.el.style.visibility = row.el.dataset["dsxMorphVis"] ?? "";
      if (arg.only === undefined) {
        row.el.style.transition = row.el.dataset["dsxMorphTrans"] ?? "";
        delete row.el.dataset["dsxMorphVis"];
        delete row.el.dataset["dsxMorphTrans"];
      }
    }
  }
  return kept.map((row) => {
    const r = row.el.getBoundingClientRect();
    return { key: row.key, x: r.x, y: r.y, w: r.width, h: r.height };
  });
};

type MorphPieceRect = { key: string; x: number; y: number; w: number; h: number };

/** A matched-geometry piece as the frame loop replays it. `match` travels between its two
 *  measured rects; `out` rides the flight box at its source-relative fractions and fades
 *  out early; `in` rides at its destination-relative fractions and fades in late. */
type MorphPieceSpec =
  | { role: "match"; src: { x: number; y: number; w: number; h: number };
      dest: { x: number; y: number; w: number; h: number } }
  | { role: "out"; rel: { x: number; y: number; w: number; h: number } }
  | { role: "in"; rel: { x: number; y: number; w: number; h: number } };

/** Apply one frame's state. Runs in the page; every value is precomputed in Node. */
type FrameApplyArg = {
  tx: number; ty: number; scale: number; alpha: number;
  caption: { text: string; alpha: number; rise: number } | null;
  texts: Array<{ role: string; enter: number }>;
  cursor: { x: number; y: number; alpha: number; scale: number } | null;
  /** the expanding contact ring: the press made visible after the instant itself */
  ring: { x: number; y: number; scale: number; alpha: number } | null;
  pose: { turn: number; tilt: number; roll: number; dx: number; dy: number; scale: number } | null;
  /** per-support float drift, indexed like the scene's frames */
  supports: Array<{ dy: number; turn: number; tilt: number }>;
  shine: { angle: number; strength: number } | null;
  shadow: { scale: number; alpha: number } | null;
  spot: { x: number; y: number; w: number; h: number; alpha: number } | null;
  morphImg: { x: number; y: number; w: number; h: number; p: number; r: number } | null;
  /** the matched-geometry pieces, indexed like the injected #morph-piece-N wrappers */
  morphPieces: Array<{ x: number; y: number; w: number; h: number;
                       alpha: number; srcAlpha: number; destAlpha: number }>;
  /** the old view (minus the shared element) receding under the morph */
  backplate: { alpha: number; scale: number; ox: number; oy: number } | null;
  /** the multiplane camera: the atmosphere planes' transforms */
  far: { tx: number; ty: number; k: number };
  near: { tx: number; ty: number; k: number };
};
const FRAME_APPLY = (f: FrameApplyArg): void => {
  // NOTE: the atmosphere planes carry no filter on purpose. A blur() on a composited
  // layer can settle into more than one stable rasterization when the layer tree
  // restructures mid-scene (measured on the morph reveal), so plane softness is baked
  // into the bokeh gradients, which paint deterministically.
  const camera = (id: string, tx: number, ty: number, k: number): void => {
    const el = document.getElementById(id)!;
    el.style.transform = `translate(${tx}px,${ty}px) scale(${k})`;
  };
  camera("world", f.tx, f.ty, f.scale);
  camera("far", f.far.tx, f.far.ty, f.far.k);
  camera("near", f.near.tx, f.near.ty, f.near.k);
  document.getElementById("veil")!.style.opacity = String(1 - f.alpha);
  const cap = document.getElementById("caption")!;
  cap.style.opacity = String(f.caption === null ? 0 : f.caption.alpha);
  cap.style.transform = `translateY(${f.caption === null ? 0 : f.caption.rise * 18}px)`;
  if (f.caption !== null) cap.querySelector("span")!.textContent = f.caption.text;
  for (const t of f.texts) {
    const el = document.querySelector(`#world [data-role="${t.role}"]`) as HTMLElement | null;
    if (el === null) continue;
    el.style.opacity = String(t.enter);
    el.style.transform = `translateY(${(1 - t.enter) * 26}px)`;
  }
  const dev = document.getElementById("device-pose");
  if (dev !== null && f.pose !== null) {
    dev.style.transform =
      `translate3d(${f.pose.dx}px, ${f.pose.dy}px, 0) ` +
      `rotateX(${f.pose.tilt}deg) rotateY(${f.pose.turn}deg) rotateZ(${f.pose.roll}deg) ` +
      `scale(${f.pose.scale})`;
  }
  for (const [i, s] of f.supports.entries()) {
    const el = document.getElementById(`support-pose-${i}`);
    if (el !== null) {
      el.style.transform =
        `translate3d(0px, ${s.dy}px, 0) rotateX(${s.tilt}deg) rotateY(${s.turn}deg)`;
    }
  }
  const shine = document.getElementById("device-shine");
  if (shine !== null && f.shine !== null) {
    shine.style.background =
      `linear-gradient(${f.shine.angle}deg, rgba(255,255,255,0) 30%, ` +
      `rgba(255,255,255,${f.shine.strength}) 50%, rgba(255,255,255,0) 70%)`;
  }
  const shadow = document.getElementById("floor-shadow");
  if (shadow !== null && f.shadow !== null) {
    shadow.style.transform = `scale(${f.shadow.scale})`;
    shadow.style.opacity = String(f.shadow.alpha);
  }
  const cur = document.getElementById("cursor")!;
  if (f.cursor === null) { cur.style.opacity = "0"; }
  else {
    cur.style.left = `${f.cursor.x}px`;
    cur.style.top = `${f.cursor.y}px`;
    cur.style.opacity = String(f.cursor.alpha);
    cur.style.transform = `scale(${f.cursor.scale})`;
  }
  const ring = document.getElementById("tapring")!;
  if (f.ring === null) { ring.style.opacity = "0"; }
  else {
    ring.style.left = `${f.ring.x}px`;
    ring.style.top = `${f.ring.y}px`;
    ring.style.opacity = String(f.ring.alpha);
    ring.style.transform = `scale(${f.ring.scale})`;
  }
  const spot = document.getElementById("spotlight");
  if (spot !== null) {
    if (f.spot === null) { spot.style.opacity = "0"; }
    else {
      spot.style.left = `${f.spot.x}px`;
      spot.style.top = `${f.spot.y}px`;
      spot.style.width = `${f.spot.w}px`;
      spot.style.height = `${f.spot.h}px`;
      spot.style.opacity = String(f.spot.alpha);
    }
  }
  const plate = document.getElementById("morph-backplate");
  if (plate !== null && f.backplate !== null) {
    plate.style.opacity = String(f.backplate.alpha);
    plate.style.transformOrigin = `${f.backplate.ox}px ${f.backplate.oy}px`;
    plate.style.transform = `scale(${f.backplate.scale})`;
  }
  const morph = document.getElementById("morph-box");
  if (morph !== null && f.morphImg !== null) {
    morph.style.left = `${f.morphImg.x}px`;
    morph.style.top = `${f.morphImg.y}px`;
    morph.style.width = `${f.morphImg.w}px`;
    morph.style.height = `${f.morphImg.h}px`;
    morph.style.borderRadius = `${f.morphImg.r}px`;
    morph.style.opacity = "1";
    // MATCHED GEOMETRY, for real: the SURFACES crossfading here carry no text - every
    // piece was hidden before these crops were taken - so this dissolve blends two flat
    // card faces and can never double-expose a word. The pieces themselves are separate
    // layers above, each existing ONCE and traveling between its measured rects; a
    // crossfade of mismatched layouts is structurally impossible. The incoming surface
    // rises to full opacity underneath the still-solid outgoing one, over the sampled
    // surface color, so the stack never goes translucent either.
    const p = f.morphImg.p;
    const out = document.getElementById("morph-out");
    if (out !== null) {
      out.style.opacity = String(p < 0.35 ? 1 : Math.max(0, 1 - (p - 0.35) / 0.3));
    }
    const into = document.getElementById("morph-in");
    if (into !== null) into.style.opacity = String(Math.min(p / 0.3, 1));
    for (const [i, pc] of f.morphPieces.entries()) {
      const wrap = document.getElementById(`morph-piece-${i}`);
      if (wrap === null) continue;
      wrap.style.left = `${pc.x}px`;
      wrap.style.top = `${pc.y}px`;
      wrap.style.width = `${pc.w}px`;
      wrap.style.height = `${pc.h}px`;
      wrap.style.opacity = String(pc.alpha);
      const imgs = wrap.querySelectorAll("img");
      if (imgs.length === 2) {
        (imgs[0] as HTMLElement).style.opacity = String(pc.destAlpha);
        (imgs[1] as HTMLElement).style.opacity = String(pc.srcAlpha);
      }
    }
    // the ELEVATION: the element lifts off, casts, and settles - zero at both endpoints,
    // so neither the departure slot nor the landed component pops a shadow
    const cast = document.getElementById("morph-shadow");
    if (cast !== null) {
      cast.style.left = `${f.morphImg.x}px`;
      cast.style.top = `${f.morphImg.y}px`;
      cast.style.width = `${f.morphImg.w}px`;
      cast.style.height = `${f.morphImg.h}px`;
      cast.style.borderRadius = `${f.morphImg.r}px`;
      cast.style.opacity = String(0.9 * Math.sin(Math.PI * p));
    }
  }
};

/** THE APP'S OWN MOTION, on the FILM clock. A compositor animation runs on the real clock
 *  the paused page clock never governs, so sampling one mid-flight would be wall-time noise
 *  in a deterministic frame - but suppressing every one (what this used to do, with
 *  reduced-motion forcing on top) decided on the author's behalf that the product does not
 *  animate, and the product's own progress fills, toggles and buttons are exactly what a
 *  commercial is selling. So each animation is driven to the phase THIS FILM INSTANT
 *  dictates: infinite ones off the scene instant, finite ones from the instant they were
 *  BORN (recorded the first frame they exist). `settle` says which of them are instead
 *  driven to their end: "all" for a mount (which lands settled) and for a fresh document's
 *  crops, "fresh" for animations born AT this instant (a film tween's own transition, or
 *  one the capture rig's DOM write created), "none" for an ordinary frame.
 *
 *  This runs BEFORE EVERY CAPTURE ATTEMPT, not once per frame: an app applies a state write
 *  on its own schedule (a reactive update can land on an animation frame, after our write
 *  evaluate returned), so a transition can be born after the frame's styles are applied.
 *  Re-phasing inside the settle loop catches it at a birth the film instant defines, which
 *  is what makes app motion deterministic rather than wall-time noise. */
const PHASE_MOTION = (f: { tMs: number; settle: "all" | "fresh" | "none" }): void => {
  const scope = globalThis as unknown as { __dsxFilmBirths?: WeakMap<Animation, number> };
  scope.__dsxFilmBirths ??= new WeakMap<Animation, number>();
  const births = scope.__dsxFilmBirths;
  for (const a of document.getAnimations()) {
    // a scroll-driven or view-driven animation does not run on a clock at all - its
    // progress is a function of the DOM state this frame already fixes, so it is left
    // alone rather than phased against a timeline it does not have
    if (a.timeline !== document.timeline) continue;
    const timing = a.effect?.getTiming();
    if (timing !== undefined && timing.iterations === Infinity) {
      // an endless one (a spinner, a shimmer) is PINNED to the instant, never merely
      // paused: a pause alone freezes it at whatever wall-clock phase it had reached
      try { a.currentTime = f.tMs; a.pause(); } catch { /* no timeline yet */ }
      continue;
    }
    // FINISH, never pause-at-the-end: an application waits on Animation.finished to clean
    // up after its own motion (the router unmounts a popped screen there), and a paused
    // animation never resolves it - the screen would stay mounted and the next navigation
    // would be dropped. A settled animation is also BORN BEFORE TIME, so the pass that
    // meets it later reads it as long finished instead of replaying it.
    const settled = (): void => {
      try { a.finish(); } catch { a.cancel(); }
      births.set(a, Number.NEGATIVE_INFINITY);
    };
    if (f.settle === "all") { settled(); continue; }
    let birth = births.get(a);
    const fresh = birth === undefined;
    if (fresh) { birth = f.tMs; births.set(a, birth); }
    // "fresh" settles only what was born AT THIS INSTANT - the transition a film tween
    // just created (the tween owns those in-betweens) or one the capture rig's own DOM
    // write created. An animation the application started earlier keeps its phase, so a
    // long app animation is not frozen for the rest of the scene by a tween passing over.
    if (f.settle === "fresh" && fresh) { settled(); continue; }
    const end = Number(a.effect?.getComputedTiming().endTime ?? NaN);
    if (!Number.isFinite(end)) { settled(); continue; }
    const at = Math.min(Math.max(f.tMs - birth!, 0), end);
    try {
      if (at >= end) { settled(); continue; }
      a.currentTime = at;
      a.pause();
    } catch { settled(); }
  }
};

// ── encoders, behind the one interface the vision requires stays replaceable ─────────

type FilmEncoder = {
  add(png: Buffer, frameIndex: number): Promise<void>;
  finish(): Promise<string>;
};

/** The PREVIEW tier: WebCodecs VP9 in a dedicated page on the secure film origin, muxed by
 *  webm.ts. Zero install: everything runs in the browser the toolchain already pins. */
async function webmEncoder(
  context: FilmContext, film: Film, outPath: string,
): Promise<FilmEncoder> {
  const page = await context.newPage();
  await page.route("**/*", async (route) => {
    await route.fulfill({ contentType: "text/html", body: "<!doctype html><title>enc</title>" });
  });
  await page.goto(`${FILM_ORIGIN}/enc`, { waitUntil: "load" });
  type EncPage = {
    __chunks: Array<{ b64: string; key: boolean; us: number }>;
    __encoder: { configure(c: unknown): void; encode(f: unknown, o: unknown): void; flush(): Promise<void> };
    __encError?: string;
  };
  await page.evaluate(
    (cfg: { width: number; height: number; fps: number }) => {
      const w = globalThis as unknown as EncPage & {
        VideoEncoder: new (init: unknown) => EncPage["__encoder"];
      };
      w.__chunks = [];
      w.__encoder = new w.VideoEncoder({
        output: (chunk: { byteLength: number; type: string; timestamp: number; copyTo(d: Uint8Array): void }) => {
          const data = new Uint8Array(chunk.byteLength);
          chunk.copyTo(data);
          let bin = "";
          for (let i = 0; i < data.length; i += 0x8000) {
            bin += String.fromCharCode(...Array.from(data.subarray(i, i + 0x8000)));
          }
          w.__chunks.push({ b64: btoa(bin), key: chunk.type === "key", us: chunk.timestamp });
        },
        error: (e: unknown) => { w.__encError = String(e); },
      });
      w.__encoder.configure({
        codec: "vp09.00.10.08", width: cfg.width, height: cfg.height,
        bitrate: 7_000_000, framerate: cfg.fps,
      });
    },
    { width: film.format.width, height: film.format.height, fps: film.fps },
  );
  const usPerFrame = 1_000_000 / film.fps;
  // TIME-based keyframe cadence, never frame-count: the muxer's SimpleBlocks carry int16
  // cluster-relative timecodes, so a cluster must stay well under 32767ms - a fixed
  // every-90-frames cadence overflows that window the moment fps drops below ~3.
  const keyEvery = Math.max(1, Math.round(film.fps * 3));
  return {
    async add(png: Buffer, frameIndex: number): Promise<void> {
      await page.evaluate(
        async (f: { b64: string; us: number; key: boolean }) => {
          const w = globalThis as unknown as EncPage;
          if (w.__encError !== undefined) throw new Error(w.__encError);
          const res = await fetch("data:image/png;base64," + f.b64);
          const bitmap = await createImageBitmap(await res.blob());
          const VF = (globalThis as unknown as { VideoFrame: new (b: ImageBitmap, o: unknown) => { close(): void } }).VideoFrame;
          const frame = new VF(bitmap, { timestamp: f.us });
          w.__encoder.encode(frame, { keyFrame: f.key });
          frame.close();
          bitmap.close();
        },
        { b64: png.toString("base64"), us: Math.round(frameIndex * usPerFrame), key: frameIndex % keyEvery === 0 },
      );
    },
    async finish(): Promise<string> {
      const chunks = await page.evaluate<Array<{ b64: string; key: boolean; us: number }>>(
        async () => {
          const w = globalThis as unknown as EncPage;
          await w.__encoder.flush();
          if (w.__encError !== undefined) throw new Error(w.__encError);
          return w.__chunks;
        },
      );
      const frames: WebmFrame[] = chunks.map((c) => ({
        data: Buffer.from(c.b64, "base64"),
        timecodeMs: Math.round(c.us / 1000),
        key: c.key,
      }));
      const bytes = muxWebm(frames, film.format.width, film.format.height, film.durationMs);
      writeFileSync(outPath, bytes);
      return outPath;
    },
  };
}

/** The MASTER tier: FFmpeg to H.264 + yuv420p, the store-acceptable codec the open-source
 *  browser cannot produce. Selected only when the binary exists; doctor reports its absence. */
function ffmpegEncoder(film: Film, outPath: string): FilmEncoder {
  const dir = join(tmpdir(), `dsx-film-${film.id}-${process.pid}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return {
    add(png: Buffer, frameIndex: number): Promise<void> {
      writeFileSync(join(dir, `f${String(frameIndex).padStart(6, "0")}.png`), png);
      return Promise.resolve();
    },
    finish(): Promise<string> {
      const run = spawnSync("ffmpeg", [
        "-y", "-framerate", String(film.fps), "-i", join(dir, "f%06d.png"),
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18",
        "-movflags", "+faststart", outPath,
      ], { stdio: "ignore" });
      rmSync(dir, { recursive: true, force: true });
      if (run.status !== 0) throw new Error("ffmpeg failed encoding the master");
      return Promise.resolve(outPath);
    },
  };
}

// ── per-scene mounting ───────────────────────────────────────────────────────────────

type MountedScene = {
  page: ShotPage;
  concreteCamera: CameraMove[];
  home: CameraState;
  deviceCenter: { x: number; y: number } | null;
  /** tap target -> measured stage-space center, for the cursor */
  tapPoints: Map<string, { x: number; y: number }>;
  /** every measured landmark's neutral-camera box (camera, tap, focus, morph targets) */
  boxes: Map<string, { x: number; y: number; w: number; h: number }>;
  /** the hero handoff: the outgoing component's on-screen rect + its captured pixels */
  morphStart: { x: number; y: number; w: number; h: number } | null;
  /** the matched-geometry pieces the flight replays (empty until the morph is armed) */
  morphPieces: MorphPieceSpec[];
  /** visual corner radii: source at capture scale, destination at neutral-camera scale -
   *  the flight box clips its rectangular crops at exactly the interpolated curve */
  morphRadii: { src: number; dest: number } | null;
  morphDone: boolean;
  errors: string[];
};

/** The film-origin route: '/' serves the given page HTML, everything else resolves through
 *  the project's asset jail. ONE handler for the stage page and every scratch page. */
async function routeFilmOrigin(page: ShotPage, opts: FilmRenderOptions, html: string): Promise<void> {
  await page.route("**/*", async (route) => {
    const url = route.request().url();
    if (!url.startsWith(FILM_ORIGIN)) { await route.abort(); return; }
    const path = url.substring(FILM_ORIGIN.length).split("?")[0] ?? "/";
    if (path === "/" || path === "") {
      await route.fulfill({ contentType: "text/html", body: html });
      return;
    }
    const asset = safeProjectPath(opts.projectRoot, path);
    if (asset !== null && existsSync(asset)) {
      await route.fulfill({ contentType: contentTypeFor(asset), body: readFileSync(asset) });
      return;
    }
    await route.abort();
  });
}

/** Boot one project document into a page carrying an #app mount - the ONE sequence the
 *  stage's primary and every support snapshot share, so a change to the boot law lands
 *  once. Returns the problems; empty means the document is mounted and settled. */
async function bootDocument(
  page: ShotPage, config: ProjectConfig, film: Film,
  mount: { document: string; state: string },
  bundle: string, faceCss: string,
  registry: ReturnType<typeof buildProjectRegistry>["registry"],
): Promise<string[]> {
  const preset = film.states.find((s) => s.name === mount.state);
  const profile: ShotProfile = {
    document: mount.document,
    vars: preset?.vars ?? {},
    globals: preset?.globals ?? {},
    allowEmpty: true,
  };
  const plan = planShot(config, { shots: [] }, profile);
  const errors = [...plan.errors];
  for (const row of plan.scope.unresolved) {
    errors.push(`unresolved ${row.kind} "${row.name}": ${row.fix}`);
  }
  if (errors.length > 0) return errors;
  const qualified = resolveDocument(registry, config.scheme, mount.document);
  if (qualified === null) return [`document ${mount.document} is not in the registry`];
  await page.addScriptTag({ content: bundle });
  if (faceCss.length > 0) await page.addStyleTag({ content: faceCss });
  await page.addStyleTag({ content: registry.css });
  await page.evaluate(
    ([reg, entry, globals, vars, attrs]: [unknown, string, unknown, unknown, unknown]) =>
      (globalThis as unknown as {
        __dsxShotBoot: (r: unknown, e: string, g: unknown, v: unknown, a: unknown) => void;
      }).__dsxShotBoot(reg, entry, globals, vars, attrs),
    [registry, qualified, plan.scope.globals, plan.scope.vars, plan.scope.attrs],
  );
  await waitForSettle(page);
  await page.evaluate(PHASE_MOTION, { tMs: 0, settle: "all" as const });
  return [];
}

/** The per-scene clock anchor spacing. A scene's frames advance the clock from its anchor
 *  by up to the film's whole duration, and the SUPPORT anchor sits at half a step before
 *  the scene's own - so the step must exceed twice the longest possible advance for
 *  pauseAt (which cannot rewind) to stay monotonic on any lawful film. */
function anchorStepMs(film: Film): number {
  return 600_000 + 2 * film.durationMs;
}

/** Capture one side of a morph boundary under the ISOLATION law: measure the pieces, hide
 *  them ALL, then show each piece alone for its own crop - a parent piece's pixels can
 *  never bake a child piece's content, and the surface crop carries no piece at all. The
 *  page is left with every piece hidden; the caller restores (or hides the whole card). */
async function captureMorphSide(
  page: ShotPage, format: { width: number; height: number }, sel: string,
  cardRect: { x: number; y: number; w: number; h: number },
  phase: { tMs: number; settle: "all" | "fresh" | "none" },
): Promise<
  { pieces: Array<MorphPieceRect & { b64: string }>; surfaceB64: string } | { error: string }
> {
  const cardClip = stageClip(format, cardRect);
  if (!(cardClip.width > 0 && cardClip.height > 0)) {
    return { error: `morph target ${sel} lies outside the visible stage` };
  }
  const shooter = page as unknown as { screenshot(o: unknown): Promise<Buffer> };
  const measured = await page.evaluate<MorphPieceRect[] | null>(
    MORPH_PIECES_OP, { sel, op: "measure" as const }) ?? [];
  await page.evaluate<MorphPieceRect[] | null>(
    MORPH_PIECES_OP, { sel, op: "hide" as const });
  const pieces: Array<MorphPieceRect & { b64: string }> = [];
  for (const [i, piece] of measured.entries()) {
    const c = stageClip(format, piece);
    if (!(c.width > 0 && c.height > 0)) continue;
    await page.evaluate<MorphPieceRect[] | null>(
      MORPH_PIECES_OP, { sel, op: "restore" as const, only: i });
    await stableScreenshot(shooter, () => page.evaluate(PHASE_MOTION, phase));
    const crop = await shooter.screenshot({ type: "png", clip: c });
    await page.evaluate<MorphPieceRect[] | null>(
      MORPH_PIECES_OP, { sel, op: "hide" as const, only: i });
    pieces.push({ ...piece, b64: crop.toString("base64") });
  }
  await stableScreenshot(shooter, () => page.evaluate(PHASE_MOTION, phase));
  const surface = await shooter.screenshot({ type: "png", clip: cardClip });
  return { pieces, surfaceB64: surface.toString("base64") };
}

/** A supporting frame's screen: its document booted in a scratch page at the app's logical
 *  size, settled, captured under the same settle law as every kept frame, then closed. The
 *  window and the app share one aspect by construction, so the snapshot fills the support
 *  chassis's window without distortion. */
async function supportScreenB64(
  context: FilmContext, config: ProjectConfig, film: Film,
  row: { document: string; state: string },
  bundle: string, faceCss: string,
  registry: ReturnType<typeof buildProjectRegistry>["registry"], opts: FilmRenderOptions,
): Promise<{ b64: string } | { error: string }> {
  const page = await context.newPage();
  const pageErrors: string[] = [];
  page.on("pageerror", (e: never) => pageErrors.push((e as Error).message));
  try {
    await (page as unknown as {
      setViewportSize(s: { width: number; height: number }): Promise<void>;
    }).setViewportSize(APP_LOGICAL);
    await routeFilmOrigin(page, opts,
      `<!doctype html><html><head><meta charset="utf-8"><title>support</title>`
        + `<style>html,body{margin:0;width:${APP_LOGICAL.width}px;`
        + `height:${APP_LOGICAL.height}px;overflow:hidden;background:${film.theme.bg}}`
        + `#app{position:absolute;inset:0}</style></head>`
        + `<body><div id="app"></div></body></html>`);
    await page.goto(`${FILM_ORIGIN}/`, { waitUntil: "load" });
    const problems = await bootDocument(page, config, film, row, bundle, faceCss, registry);
    if (problems.length > 0) return { error: problems.join("; ") };
    if (pageErrors.length > 0) return { error: `pageerror: ${pageErrors.join("; ")}` };
    const png = await stableScreenshot(
      page as unknown as { screenshot(o: unknown): Promise<Buffer> },
      () => page.evaluate(PHASE_MOTION, { tMs: 0, settle: "all" as const }));
    return { b64: png.toString("base64") };
  } finally {
    await (page as unknown as { close(): Promise<void> }).close();
  }
}

async function mountScene(
  context: FilmContext, config: ProjectConfig, film: Film, scene: FilmScene,
  sceneIndex: number,
  bundle: string, faceCss: string,
  registry: ReturnType<typeof buildProjectRegistry>["registry"], opts: FilmRenderOptions,
  baseAt: Date,
  supportCache: Map<string, string>,
): Promise<MountedScene> {
  const errors: string[] = [];
  const page = await context.newPage();
  page.on("pageerror", (e: never) => errors.push(`pageerror: ${(e as Error).message}`));

  await routeFilmOrigin(page, opts, stageHtml(film));
  await page.goto(`${FILM_ORIGIN}/`, { waitUntil: "load" });

  const { width, height } = film.format;
  const home: CameraState = { x: width / 2, y: height / 2, scale: 1 };

  // the device box: centered horizontally, vertically balanced a little above center.
  // A frameless scene knows only its WIDTH here - the height is the component's own
  // (content hugs by law), measured after settle by FRAMELESS_PLACE.
  let device: { x: number; y: number; width: number; height: number } | null = null;
  let frameless: { width: number } | null = null;
  let deviceCenter: { x: number; y: number } | null = null;
  if (scene.document !== "" && scene.frame === "none") {
    frameless = { width: (scene.deviceWidth > 0 ? scene.deviceWidth : 0.8) * width };
  } else if (scene.document !== "") {
    const dw = (scene.deviceWidth > 0 ? scene.deviceWidth : 0.78) * width;
    const dh = dw / ART_ASPECT;
    device = { x: (width - dw) / 2, y: (height - dh) * 0.42, width: dw, height: dh };
    deviceCenter = { x: device.x + dw / 2, y: device.y + dh / 2 };
  }
  const supports: SceneSetupArg["supports"] = [];
  if (scene.frames.length > 0) {
    // FREEZE the clock before any snapshot: for the first scene it is still auto-advancing
    // from install, and a support document rendering clock-derived content would bake a
    // run-dependent instant into frozen pixels for the whole scene. The support anchor
    // sits halfway to this scene's own anchor, so the sequence stays monotonic.
    await context.clock.pauseAt(new Date(
      baseAt.getTime() + (sceneIndex + 1) * anchorStepMs(film) - anchorStepMs(film) / 2));
  }
  for (const row of scene.frames) {
    // one boot per (document, state) across the whole render - a repeated pair reuses the
    // settled pixels, which is behaviorally identical for a static screen
    const key = JSON.stringify([row.document, row.state]);
    let b64 = supportCache.get(key);
    if (b64 === undefined) {
      const shot = await supportScreenB64(context, config, film, row, bundle, faceCss, registry, opts);
      if ("error" in shot) {
        errors.push(`supporting frame ${row.document}: ${shot.error}`);
        continue;
      }
      b64 = shot.b64;
      supportCache.set(key, b64);
    }
    supports.push({
      x: row.x, y: row.y, width: row.width * width, depth: row.depth, screenB64: b64,
    });
  }
  if (errors.length > 0) {
    return { page, concreteCamera: [], home, deviceCenter, tapPoints: new Map(),
             boxes: new Map(), morphStart: null, morphPieces: [], morphRadii: null, morphDone: false, errors };
  }
  await page.evaluate(SCENE_SETUP, {
    texts: scene.texts, device, frameless, window: WINDOW, appWidth: APP_LOGICAL.width,
    art: DEVICE_ART,
    glow: scene.glow === "accent" ? film.theme.accent : scene.glow,
    stage: film.format,
    bokeh: BOKEH,
    reflectMask: REFLECT_MASK,
    supports,
    artAspect: ART_ASPECT,
  });

  if (scene.document !== "") {
    errors.push(...await bootDocument(
      page, config, film, { document: scene.document, state: scene.state },
      bundle, faceCss, registry));
    if (errors.length > 0) {
      return { page, concreteCamera: [], home, deviceCenter, tapPoints: new Map(),
               boxes: new Map(), morphStart: null, morphPieces: [], morphRadii: null, morphDone: false, errors };
    }
    if (frameless !== null) {
      const box = await page.evaluate<{ x: number; y: number; w: number; h: number }>(
        FRAMELESS_PLACE,
        { stage: film.format, appWidth: APP_LOGICAL.width, reflectMask: REFLECT_MASK });
      await page.evaluate(PHASE_MOTION, { tMs: 0, settle: "all" as const });
      deviceCenter = { x: box.x + box.w / 2, y: box.y + box.h / 2 };
    }
  }

  // Freeze the clock at a DETERMINISTIC anchor. pauseAt cannot rewind, and mount/settle has
  // just consumed a run-dependent slice of wall time - so the anchor is a fixed FUTURE
  // instant per scene (ten minutes apart, far beyond any settle budget), identical in every
  // run and monotonic across scenes. From here on the app sees only this instant plus exact
  // frame periods, which is the whole determinism story.
  await context.clock.pauseAt(new Date(baseAt.getTime() + (sceneIndex + 1) * anchorStepMs(film)));

  // measure semantic targets at the neutral camera, then hand the kernel concrete moves
  const targets = [...new Set([
    ...scene.camera.map((m) => m.target).filter((t) => t !== ""),
    ...scene.taps.map((t) => t.target),
    ...scene.focus.map((f) => f.target),
    ...(scene.morph !== null ? [scene.morph.target] : []),
  ])];
  const boxes = await page.evaluate<{ [sel: string]: { x: number; y: number; w: number; h: number } | null }>(
    (sels: string[]) => {
      const out: { [sel: string]: { x: number; y: number; w: number; h: number } | null } = {};
      for (const sel of sels) {
        const el = document.querySelector(sel);
        if (el === null) { out[sel] = null; continue; }
        const r = el.getBoundingClientRect();
        out[sel] = { x: r.x, y: r.y, w: r.width, h: r.height };
      }
      return out;
    },
    targets,
  );
  const measured = new Map<string, { x: number; y: number; w: number; h: number }>();
  for (const [sel, box] of Object.entries(boxes)) {
    if (box !== null) measured.set(sel, box);
  }
  for (const f of scene.focus) {
    if (!measured.has(f.target)) {
      errors.push(`focus target ${f.target} was not found in the mounted scene`);
    }
  }
  if (scene.morph !== null && !measured.has(scene.morph.target)) {
    errors.push(`morph target ${scene.morph.target} was not found in the mounted scene`);
  }
  const tapPoints = new Map<string, { x: number; y: number }>();
  for (const tap of scene.taps) {
    const box = boxes[tap.target];
    if (box === null || box === undefined) {
      errors.push(`tap target ${tap.target} was not found in the mounted scene`);
      continue;
    }
    tapPoints.set(tap.target, { x: box.x + box.w / 2, y: box.y + box.h / 2 });
  }
  const concreteCamera: CameraMove[] = [];
  for (const move of scene.camera) {
    if (move.target === "") {
      concreteCamera.push({
        atMs: move.atMs, forMs: move.forMs,
        toX: home.x, toY: home.y, toScale: move.zoom, ease: move.ease,
      });
      continue;
    }
    const box = boxes[move.target];
    if (box === null || box === undefined) {
      errors.push(`camera target ${move.target} was not found in the mounted scene`);
      continue;
    }
    concreteCamera.push({
      atMs: move.atMs, forMs: move.forMs,
      toX: box.x + box.w / 2, toY: box.y + box.h / 2, toScale: move.zoom, ease: move.ease,
    });
  }
  return { page, concreteCamera, home, deviceCenter, tapPoints,
           boxes: measured, morphStart: null, morphPieces: [], morphRadii: null, morphDone: false, errors };
}

// ── the render ───────────────────────────────────────────────────────────────────────

export async function renderFilm(
  browser: unknown, config: ProjectConfig, film: Film, opts: FilmRenderOptions,
): Promise<FilmOutcome> {
  const problems = validateFilm(film);
  if (problems.length > 0) {
    return { ok: false, problems, errors: [], videoPath: null, frameCount: 0, frameHashes: [] };
  }

  const wantMp4 = opts.encoder === "mp4" || (opts.encoder === "auto" && ffmpegAvailable());
  if (opts.encoder === "mp4" && !ffmpegAvailable()) {
    return {
      ok: false, problems: [],
      errors: ["the mp4 master tier needs ffmpeg on PATH (the store codecs are not in the open-source browser) - render the webm preview, or install ffmpeg"],
      videoPath: null, frameCount: 0, frameHashes: [],
    };
  }

  const context = await (browser as FilmBrowser).newContext({
    viewport: { width: film.format.width, height: film.format.height },
    deviceScaleFactor: 1,
    colorScheme: film.theme.scheme ?? "light",
    // the app ANIMATES in a film: its progress fills, toggles and buttons are what the
    // commercial is selling, and forcing reduced motion here turned every one of them off.
    // Determinism comes from driving each animation to the phase the film instant dictates
    // (FRAME_APPLY) rather than from suppressing them, so the preference stays honest.
    reducedMotion: "no-preference",
    locale: "en-US",
    timezoneId: "UTC",
    ignoreHTTPSErrors: true,
  });
  const baseAt = new Date("2026-01-01T09:41:00Z");
  await context.clock.install({ time: baseAt });
  await context.addInitScript({
    content: `(() => {
      let seed = 0x2545f491;
      Math.random = () => {
        seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
        return ((seed >>> 0) % 1e9) / 1e9;
      };
    })();`,
  });

  const errors: string[] = [];
  const frameHashes: string[] = [];
  let videoPath: string | null = null;

  try {
    mkdirSync(opts.outDir, { recursive: true });
    const outPath = join(opts.outDir, `${film.id}.${wantMp4 ? "mp4" : "webm"}`);
    const encoder = wantMp4
      ? ffmpegEncoder(film, outPath)
      : await webmEncoder(context, film, outPath);

    const bundle = bundleHarness(opts.webRoot);
    const faceCss = bundledFaceCss(opts.webRoot);
    const { registry } = buildProjectRegistry(config, "web");

    const total = filmFrameCount(film);
    const limit = opts.frameLimit === undefined ? total : Math.min(opts.frameLimit, total);
    const frameMs = 1000 / film.fps;

    let mounted: MountedScene | null = null;
    let mountedIndex = -1;
    /** scene-local instant of the last frame DRAWN - the phase a boundary capture of the
     *  outgoing page must be taken at, so its crops match the frame before the cut */
    let lastLocalMs = 0;
    /** settled support screens by (document, state) - one boot per pair per render */
    const supportCache = new Map<string, string>();
    let advancedToMs = 0;

    for (let f = 0; f < limit; f++) {
      const tMs = f * frameMs;
      const frame = filmFrameAt(film, tMs, frameMs);
      const scene = film.scenes[frame.index]!;

      if (frame.index !== mountedIndex) {
        // THE HERO HANDOFF - the View Transition snapshot pair, exactly the model SwiftUI's
        // matchedGeometryEffect and the web's ::view-transition use. From the OUTGOING page,
        // before it closes: (1) the shared ELEMENT's on-screen rect and pixels
        // (getBoundingClientRect includes every live transform, so this is exactly what the
        // viewer last saw), then (2) the OLD VIEW WITHOUT THE ELEMENT - the element is
        // hidden and the full stage captured - so the old context can visibly recede UNDER
        // the traveling element instead of vanishing at the cut, with no ghost copy of the
        // element left behind in it.
        let handoff: {
          rect: { x: number; y: number; w: number; h: number };
          /** the source card's visual corner radius at capture scale */
          radius: number;
          surfaceB64: string;
          plateB64: string;
          pieces: Array<{ key: string; x: number; y: number; w: number; h: number; b64: string }>;
        } | null = null;
        if (scene.morph !== null && mounted !== null) {
          const rect = await mounted.page.evaluate<
            { x: number; y: number; w: number; h: number; radius: number } | null
          >(
            (sel: string) => {
              // finalize the OUTGOING page's own morph first: a full-length morph never
              // reaches its reveal frame, and measuring around a still-mounted overlay
              // would burn its ghost into both snapshots
              document.getElementById("morph-box")?.remove();
              document.getElementById("morph-pieces")?.remove();
              document.getElementById("morph-backplate")?.remove();
              document.getElementById("morph-shadow")?.remove();
              const el = document.querySelector(sel) as HTMLElement | null;
              if (el === null) return null;
              el.style.opacity = "";
              const r = el.getBoundingClientRect();
              // the element's VISUAL corner radius: the style value scaled by whatever
              // transform stack sits between layout and the screen - the flight box must
              // clip its rectangular crops at exactly this curve
              const style = parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0;
              const radius = style * (el.offsetWidth > 0 ? r.width / el.offsetWidth : 1);
              return { x: r.x, y: r.y, w: r.width, h: r.height, radius };
            },
            scene.morph.target,
          );
          if (rect === null || rect.w <= 0 || rect.h <= 0) {
            errors.push(`scene ${frame.index + 1}: morph target ${scene.morph.target} was not found in the outgoing scene`);
            break;
          }
          const clip = stageClip(film.format, rect);
          const oldPage = mounted.page as unknown as { screenshot(o: unknown): Promise<Buffer> };
          // the OUTGOING page is captured at the phase the viewer LAST SAW, not settled:
          // a transition still in flight at the cut would otherwise jump to its end value
          // for the crops and pop against the frame drawn one period earlier
          // "fresh": the visibility writes this capture makes must not animate, while a
          // transition the app started before the cut keeps the phase the viewer saw
          const outPhase = { tMs: lastLocalMs, settle: "fresh" as const };
          await stableScreenshot(oldPage, () => mounted!.page.evaluate(PHASE_MOTION, outPhase));
          const outSide = await captureMorphSide(
            mounted.page, film.format, scene.morph.target, rect, outPhase);
          if ("error" in outSide) {
            errors.push(`scene ${frame.index + 1}: ${outSide.error} (outgoing scene)`);
            break;
          }
          // pieces are left hidden - the page closes after the plate, so hide the whole
          // card and capture the OLD VIEW WITHOUT THE ELEMENT under the same settle law
          await mounted.page.evaluate(
            (arg: { sel: string }) => {
              const el = document.querySelector(arg.sel) as HTMLElement | null;
              if (el !== null) el.style.visibility = "hidden";
            },
            { sel: scene.morph.target },
          );
          const plate = await stableScreenshot(
            oldPage, () => mounted!.page.evaluate(PHASE_MOTION, outPhase));
          handoff = {
            rect: { x: clip.x, y: clip.y, w: clip.width, h: clip.height },
            radius: rect.radius,
            surfaceB64: outSide.surfaceB64,
            plateB64: plate.toString("base64"),
            pieces: outSide.pieces,
          };
        }
        if (mounted !== null) await (mounted.page as unknown as { close(): Promise<void> }).close();
        mounted = await mountScene(
          context, config, film, scene, frame.index, bundle, faceCss, registry, opts, baseAt,
          supportCache);
        mountedIndex = frame.index;
        advancedToMs = scene.atMs;
        if (mounted.errors.length > 0) {
          errors.push(...mounted.errors.map((e) => `scene ${frame.index + 1}: ${e}`));
          break;
        }
        if (scene.morph !== null) {
          if (handoff === null) {
            errors.push(`scene ${frame.index + 1}: a morph needs the previous scene on screen`);
            break;
          }
          mounted.morphStart = handoff.rect;
          // the INCOMING scene must lay the target out too - a missing destination would
          // otherwise freeze the opaque backplate over the whole flight and hard-pop on
          // removal, silently; refuse it the way the missing outgoing target is refused
          const destBox = mounted.boxes.get(scene.morph.target);
          if (destBox === undefined) {
            errors.push(`scene ${frame.index + 1}: morph target ${scene.morph.target} was not found in the incoming scene`);
            break;
          }
          // the destination's own pieces and its text-free surface, the same capture law
          // as the outgoing side; then restore exactly what the capture hid (the card is
          // hidden WHOLE by the arming below)
          const inSide = await captureMorphSide(
            mounted.page, film.format, scene.morph.target, destBox,
            { tMs: 0, settle: "all" as const });
          if ("error" in inSide) {
            errors.push(`scene ${frame.index + 1}: ${inSide.error} (incoming scene)`);
            break;
          }
          await mounted.page.evaluate<MorphPieceRect[] | null>(
            MORPH_PIECES_OP, { sel: scene.morph.target, op: "restore" as const });
          // the DESTINATION's visual corner radius at the neutral camera - with the
          // source's, the flight clips its crops at the exact interpolated curve, so the
          // rectangular screenshots' baked corner pixels can never show as a dark frame
          const destRadius = await mounted.page.evaluate<number>(
            (sel: string) => {
              const el = document.querySelector(sel) as HTMLElement | null;
              if (el === null) return 0;
              const r = el.getBoundingClientRect();
              const style = parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0;
              return style * (el.offsetWidth > 0 ? r.width / el.offsetWidth : 1);
            },
            scene.morph.target,
          );
          mounted.morphRadii = { src: handoff.radius, dest: destRadius };
          // MATCH: text pieces pair by their exact text (a title travels to where that
          // title lives now); textless leaves pair by document order (a dot to a dot).
          // What only the source has fades out early; what only the destination has fades
          // in late. Every piece exists ONCE - the double exposure is gone by construction.
          const usedDest = new Set<number>();
          const specs: MorphPieceSpec[] = [];
          const injectPieces: Array<{ srcB64: string; destB64: string }> = [];
          const from = handoff.rect;
          for (const src of handoff.pieces) {
            let di = -1;
            for (const [j, dest] of inSide.pieces.entries()) {
              if (usedDest.has(j)) continue;
              if (src.key !== "" ? dest.key === src.key : dest.key === "") { di = j; break; }
            }
            if (di >= 0) {
              usedDest.add(di);
              const dest = inSide.pieces[di]!;
              specs.push({ role: "match",
                src: { x: src.x, y: src.y, w: src.w, h: src.h },
                dest: { x: dest.x, y: dest.y, w: dest.w, h: dest.h } });
              injectPieces.push({ srcB64: src.b64, destB64: dest.b64 });
            } else {
              specs.push({ role: "out", rel: {
                x: (src.x - from.x) / from.w, y: (src.y - from.y) / from.h,
                w: src.w / from.w, h: src.h / from.h } });
              injectPieces.push({ srcB64: src.b64, destB64: "" });
            }
          }
          for (const [j, dest] of inSide.pieces.entries()) {
            if (usedDest.has(j)) continue;
            specs.push({ role: "in", rel: {
              x: (dest.x - destBox.x) / destBox.w, y: (dest.y - destBox.y) / destBox.h,
              w: dest.w / destBox.w, h: dest.h / destBox.h } });
            injectPieces.push({ srcB64: "", destB64: dest.b64 });
          }
          mounted.morphPieces = specs;
          await mounted.page.evaluate(
            async (arg: {
              outB64: string; inB64: string; plateB64: string; sel: string;
              pieces: Array<{ srcB64: string; destB64: string }>;
            }) => {
              const chrome = document.getElementById("chrome")!;
              // the OLD VIEW (minus the element) as a full-stage backplate BELOW the
              // traveling element: it recedes and dims while the element grows, which is
              // what makes the boundary read as one continuous space instead of a cut
              const plate = document.createElement("img");
              plate.id = "morph-backplate";
              plate.src = "data:image/png;base64," + arg.plateB64;
              chrome.insertBefore(plate, document.getElementById("spotlight"));
              const cast = document.createElement("div");
              cast.id = "morph-shadow";
              chrome.insertBefore(cast, document.getElementById("spotlight"));
              const box = document.createElement("div");
              box.id = "morph-box";
              // TEXT-FREE surfaces: incoming underneath, outgoing on top - flat faces
              // whose dissolve cannot double-expose anything
              const into = document.createElement("img");
              into.id = "morph-in";
              into.src = "data:image/png;base64," + arg.inB64;
              into.style.opacity = "0";
              const out = document.createElement("img");
              out.id = "morph-out";
              out.src = "data:image/png;base64," + arg.outB64;
              box.append(into, out);
              // the element's own surface color, sampled from the text-free surface crop,
              // fills the box behind both - no sliver of the receding view at any aspect
              try {
                await out.decode();
                const canvas = document.createElement("canvas");
                canvas.width = out.naturalWidth;
                canvas.height = out.naturalHeight;
                const g = canvas.getContext("2d")!;
                g.drawImage(out, 0, 0);
                const h = out.naturalHeight;
                const strip = g.getImageData(4, Math.max(0, h - 8), Math.max(1, Math.floor(out.naturalWidth / 4)), 4).data;
                let r = 0, gr = 0, b = 0, n = 0;
                for (let i = 0; i < strip.length; i += 4) { r += strip[i]!; gr += strip[i + 1]!; b += strip[i + 2]!; n++; }
                box.style.background =
                  `rgb(${Math.round(r / n)}, ${Math.round(gr / n)}, ${Math.round(b / n)})`;
              } catch { /* an undecodable crop leaves the box transparent */ }
              chrome.insertBefore(box, document.getElementById("caption"));
              // the pieces, ABOVE the box in stage coordinates: dest under src inside each
              // wrapper, so a matched piece's landing dissolve is like-on-like at one rect
              const layer = document.createElement("div");
              layer.id = "morph-pieces";
              for (const [i, piece] of arg.pieces.entries()) {
                const wrap = document.createElement("div");
                wrap.id = `morph-piece-${i}`;
                wrap.className = "morph-piece";
                wrap.style.opacity = "0";
                if (piece.destB64 !== "") {
                  const d = document.createElement("img");
                  d.src = "data:image/png;base64," + piece.destB64;
                  wrap.append(d);
                }
                if (piece.srcB64 !== "") {
                  const s = document.createElement("img");
                  s.src = "data:image/png;base64," + piece.srcB64;
                  wrap.append(s);
                }
                layer.append(wrap);
              }
              chrome.insertBefore(layer, document.getElementById("caption"));
              const el = document.querySelector(arg.sel) as HTMLElement | null;
              if (el !== null) el.style.opacity = "0";
            },
            { outB64: handoff.surfaceB64, inB64: inSide.surfaceB64,
              plateB64: handoff.plateB64, sel: scene.morph.target, pieces: injectPieces },
          );
        }
      }
      const m = mounted!;

      // advance the paused clock to exactly this frame's instant
      const step = Math.round(tMs) - Math.round(advancedToMs);
      if (step > 0) await context.clock.runFor(step);
      advancedToMs = tMs;

      // dispatch this frame's taps into the REAL app before drawing it
      for (const tap of frame.taps) {
        await m.page.evaluate(
          (sel: string) => {
            const el = document.querySelector(sel) as HTMLElement | null;
            if (el !== null) el.click();
          },
          tap.target,
        );
      }
      // and this frame's state writes - through the same door devtools uses, into the
      // app's REAL store, so a count-up is the app rendering its own state
      if (frame.writes.length > 0) {
        await m.page.evaluate(
          (rows: Array<{ name: string; value: unknown }>) => {
            const door = (globalThis as {
              __DSX_STATE__?: { set(n: string, v: unknown): boolean };
            }).__DSX_STATE__;
            if (door !== undefined) for (const r of rows) door.set(r.name, r.value);
          },
          frame.writes,
        );
      }

      const cam = cameraAt(m.concreteCamera, frame.tMs, m.home);
      const { width, height } = film.format;

      // THE CINEMATIC TRACK: authored pose + the idle float, both pure functions of the
      // scene-local instant. The float rides ON TOP so an authored hold still breathes.
      let poseArg: { turn: number; tilt: number; roll: number; dx: number; dy: number; scale: number } | null = null;
      let shineArg: { angle: number; strength: number } | null = null;
      let shadowArg: { scale: number; alpha: number } | null = null;
      if (scene.document !== "") {
        const pose = poseAt(scene.poses, frame.tMs, POSE_HOME);
        let drift = scene.float ? floatAt(frame.tMs) : { y: 0, turn: 0, tilt: 0 };
        // a FLAT component has no thickness for a rotation to reveal - a few degrees of
        // rotateY on it reads as skew, not motion - so the frameless float keeps only its
        // position channel; the rotational breathing belongs to the device
        if (scene.frame === "none") drift = { y: drift.y, turn: 0, tilt: 0 };
        const turn = pose.turn + drift.turn;
        const tilt = pose.tilt + drift.tilt;
        poseArg = {
          turn, tilt, roll: pose.roll,
          dx: pose.x * width,
          dy: (pose.y + drift.y) * height,
          scale: pose.scale,
        };
        // the specular: a raking band whose position follows the turn, bright while the
        // device is visibly rotated, gone when face-on - light on glass is what tells the
        // eye this is an object, and a shine on a flat phone reads as dirt. A frameless
        // component has no glass, so it gets none.
        if (scene.frame !== "none") {
          shineArg = {
            angle: 100 + turn * 2.2,
            strength: Math.min(Math.abs(turn) / 26, 1) * 0.16,
          };
        }
        // the floor shadow: smaller and fainter as the device lifts or shrinks
        shadowArg = {
          scale: pose.scale * (1 - Math.abs(pose.y + drift.y) * 1.6),
          alpha: Math.max(0.25, 0.5 - Math.abs(turn) / 90) * pose.scale,
        };
      }
      // supporting frames float on their OWN phases - offset per index and depth so the
      // frames weave between each other instead of bobbing in lockstep, with depth scaling
      // the drift (near things move more, the one parallax cue a static layout lacks)
      const supportsArg = scene.frames.map((row, i) => {
        // a background device faces the HERO, not the viewer: a fixed yaw toward stage
        // center, stronger the further out it sits - the studio hero-shot convention
        const baseTurn = (0.5 - row.x) * 22;
        if (!scene.float) return { dy: 0, turn: baseTurn, tilt: 0 };
        const k = 1 + 0.35 * row.depth;
        const drift = floatAt(frame.tMs + 3100 * (i + 1) + (row.depth > 0 ? 1500 : 0));
        return {
          dy: drift.y * height * k,
          turn: baseTurn + drift.turn * k,
          tilt: drift.tilt * k,
        };
      });
      // a film TWEEN owns the in-betweens of what it writes: while one is in flight the
      // app's own transitions are driven to their end (a transition chasing a value that
      // moves every frame only lags it). The window is padded a frame each side so the
      // transition born by the tween's last write settles with it.
      const settleMotion: "fresh" | "none" = scene.tweens.some((tw) =>
        frame.tMs >= tw.atMs - frameMs && frame.tMs <= tw.atMs + tw.forMs + frameMs)
        ? "fresh" : "none";
      // one active caption at a time: the last one whose window contains this instant
      const caption = frame.captions.length === 0
        ? null
        : frame.captions[frame.captions.length - 1]!;
      // the cursor: visible in a window around each tap, pressing at the instant itself
      let cursor: { x: number; y: number; alpha: number; scale: number } | null = null;
      let ring: { x: number; y: number; scale: number; alpha: number } | null = null;
      for (const tap of scene.taps) {
        const point = m.tapPoints.get(tap.target);
        if (point === undefined) continue;
        const dt = frame.tMs - tap.atMs;
        if (dt < -450 || dt > 500) continue;
        const appear = Math.min(Math.max((dt + 450) / 220, 0), 1);
        const fade = Math.min(Math.max((500 - dt) / 220, 0), 1);
        // a SMOOTH press, not a binary snap: a cosine dip into the tap instant and out of
        // it, the way a finger decelerates into a surface and lifts away
        const press = Math.abs(dt) < 240
          ? 1 - 0.26 * Math.cos(((dt / 240) * Math.PI) / 2) ** 2
          : 1;
        // the cursor rides the CAMERA and the POSE's translate/scale (it points at app
        // pixels; rotation is near zero at tap time by composition, and the guards would
        // catch a tap the viewer cannot parse)
        let px = point.x;
        let py = point.y;
        if (poseArg !== null && m.deviceCenter !== null) {
          px = m.deviceCenter.x + (point.x - m.deviceCenter.x) * poseArg.scale + poseArg.dx;
          py = m.deviceCenter.y + (point.y - m.deviceCenter.y) * poseArg.scale + poseArg.dy;
        }
        cursor = {
          x: width / 2 + (px - cam.x) * cam.scale,
          y: height / 2 + (py - cam.y) * cam.scale,
          alpha: Math.min(appear, fade) * 0.95,
          scale: press,
        };
        // the CONTACT RING: an expanding, fading circle from the tap instant - the press
        // made visible, so a state change on screen reads as caused, not coincidental
        if (dt >= 0 && dt <= 380) {
          const q = dt / 380;
          ring = {
            x: cursor.x,
            y: cursor.y,
            scale: 1 + 1.3 * (1 - (1 - q) * (1 - q)),
            alpha: 0.65 * (1 - q) * (1 - q),
          };
        }
      }

      // stage-space rect of a measured box, through the pose's translate/scale and the
      // camera - the same projection the cursor rides
      const project = (box: { x: number; y: number; w: number; h: number }):
        { x: number; y: number; w: number; h: number } => {
        let cx = box.x + box.w / 2;
        let cy = box.y + box.h / 2;
        let s = 1;
        if (poseArg !== null && m.deviceCenter !== null) {
          cx = m.deviceCenter.x + (cx - m.deviceCenter.x) * poseArg.scale + poseArg.dx;
          cy = m.deviceCenter.y + (cy - m.deviceCenter.y) * poseArg.scale + poseArg.dy;
          s = poseArg.scale;
        }
        const w = box.w * s * cam.scale;
        const h = box.h * s * cam.scale;
        return {
          x: width / 2 + (cx - cam.x) * cam.scale - w / 2,
          y: height / 2 + (cy - cam.y) * cam.scale - h / 2,
          w, h,
        };
      };

      // the spotlight: the dim-everything-else window around the measured target
      let spotArg: { x: number; y: number; w: number; h: number; alpha: number } | null = null;
      if (frame.focus !== null) {
        const box = m.boxes.get(frame.focus.target);
        if (box !== undefined) spotArg = { ...project(box), alpha: frame.focus.alpha };
      }

      // the hero morph: the captured component travels from where the viewer last saw it
      // to where this scene's document lays it out (re-projected every frame, so it tracks
      // a moving camera and pose)
      let morphArg: { x: number; y: number; w: number; h: number; p: number; r: number } | null = null;
      let backplateArg: { alpha: number; scale: number; ox: number; oy: number } | null = null;
      let morphEntrance: { p: number; dx: number; dy: number } | null = null;
      let morphPiecesArg: FrameApplyArg["morphPieces"] = [];
      if (frame.morph !== null && m.morphStart !== null) {
        const dest = m.boxes.get(frame.morph.target);
        if (dest !== undefined) {
          const to = project(dest);
          const p = frame.morph.p;
          const from = m.morphStart;
          // THE VIEW TRANSITION, all three layers of it: the OLD view (minus the element)
          // recedes - dimming and shrinking a touch around the element's departure point,
          // the way an iOS zoom transition's source view falls away - while the NEW view
          // (fully opaque: only the old snapshot fades, so the ground never bleeds
          // through) grows in underneath with a 3.5% scale entrance around the element's
          // arrival point, and the element itself rides on top, continuous throughout.
          morphEntrance = { p, dx: to.x + to.w / 2, dy: to.y + to.h / 2 };
          const s = 0.965 + 0.035 * p;
          const toF = {
            x: morphEntrance.dx + (to.x - morphEntrance.dx) * s,
            y: morphEntrance.dy + (to.y - morphEntrance.dy) * s,
            w: to.w * s,
            h: to.h * s,
          };
          const boxW = from.w + (toF.w - from.w) * p;
          // the EXACT clip curve: each side's measured visual radius scaled to the box's
          // current width, blended over the flight - the rectangular crops' baked corner
          // pixels are cut off precisely at the card's own rounding, so the corners show
          // the backplate through instead of a dark frame
          const radii = m.morphRadii ?? { src: 0, dest: 0 };
          const rSrc = from.w > 0 ? radii.src * (boxW / from.w) : radii.src;
          const rDest = dest.w > 0 ? radii.dest * (boxW / dest.w) : radii.dest;
          morphArg = {
            x: from.x + (toF.x - from.x) * p,
            y: from.y + (toF.y - from.y) * p,
            w: boxW,
            h: from.h + (toF.h - from.h) * p,
            p,
            // +sin(pi p): mid-flight the clip runs a hair inside the crop's own
            // antialiased edge (baked at the card's curve), zero at both endpoints so
            // departure and landing stay pixel-exact
            r: rSrc + (rDest - rSrc) * p + 1.25 * Math.sin(Math.PI * p),
          };
          backplateArg = {
            alpha: 1 - p,
            scale: 1 - 0.045 * p,
            ox: from.x + from.w / 2,
            oy: from.y + from.h / 2,
          };
          // chrome overlays point at world pixels, so they ride the same entrance fold
          const fold = (px: number, py: number): { x: number; y: number } => ({
            x: morphEntrance!.dx + (px - morphEntrance!.dx) * s,
            y: morphEntrance!.dy + (py - morphEntrance!.dy) * s,
          });
          // THE PIECES: each exists once. A matched piece travels between its measured
          // rects (destination projected and entrance-folded like everything else), with
          // only a like-on-like dissolve to its destination pixels at one shared rect in
          // the last 15%. Source-only pieces ride the flight box at their source fractions
          // and clear out early; destination-only pieces ride at their destination
          // fractions and arrive late.
          const lerp = (a: number, b: number): number => a + (b - a) * p;
          morphPiecesArg = m.morphPieces.map((piece) => {
            if (piece.role === "match") {
              const d = project(piece.dest);
              const c = fold(d.x + d.w / 2, d.y + d.h / 2);
              const df = { x: c.x - d.w * s / 2, y: c.y - d.h * s / 2, w: d.w * s, h: d.h * s };
              return {
                x: lerp(piece.src.x, df.x), y: lerp(piece.src.y, df.y),
                w: lerp(piece.src.w, df.w), h: lerp(piece.src.h, df.h),
                alpha: 1,
                destAlpha: 1,
                srcAlpha: p < 0.85 ? 1 : 1 - (p - 0.85) / 0.15,
              };
            }
            const box = morphArg!;
            const r = {
              x: box.x + piece.rel.x * box.w, y: box.y + piece.rel.y * box.h,
              w: piece.rel.w * box.w, h: piece.rel.h * box.h,
            };
            return piece.role === "out"
              ? { ...r, alpha: Math.max(0, 1 - p / 0.25), srcAlpha: 1, destAlpha: 1 }
              : { ...r, alpha: Math.min(Math.max((p - 0.55) / 0.25, 0), 1),
                  srcAlpha: 1, destAlpha: 1 };
          });
          if (spotArg !== null) {
            const c = fold(spotArg.x + spotArg.w / 2, spotArg.y + spotArg.h / 2);
            spotArg = { x: c.x - spotArg.w * s / 2, y: c.y - spotArg.h * s / 2,
                        w: spotArg.w * s, h: spotArg.h * s, alpha: spotArg.alpha };
          }
          if (cursor !== null) {
            const c = fold(cursor.x, cursor.y);
            cursor = { ...cursor, x: c.x, y: c.y };
          }
          if (ring !== null) {
            const c = fold(ring.x, ring.y);
            ring = { ...ring, x: c.x, y: c.y };
          }
        }
      } else if (scene.morph !== null && frame.morph === null && !m.morphDone) {
        // the morph landed: reveal the real component, retire the traveling snapshots
        await m.page.evaluate(
          (sel: string) => {
            const el = document.querySelector(sel) as HTMLElement | null;
            if (el !== null) el.style.opacity = "";
            document.getElementById("morph-box")?.remove();
            document.getElementById("morph-pieces")?.remove();
            document.getElementById("morph-backplate")?.remove();
            document.getElementById("morph-shadow")?.remove();
          },
          scene.morph.target,
        );
        m.morphDone = true;
      }

      // THE MULTIPLANE CAMERA: the atmosphere planes pan and scale at a fraction (far) or
      // a multiple (near) of the subject plane's motion, each with its own slow drift and
      // depth-of-field blur that deepens as the camera pushes in - parallax is the one cue
      // that turns a flat pan into a camera moving through space, and every term is a pure
      // function of the scene-local instant.
      const t = frame.tMs / 1000;
      const plane = (
        p: number, driftX: number, driftY: number,
      ): { tx: number; ty: number; k: number } => {
        const k = 1 + (cam.scale - 1) * p;
        const cx = width / 2 + (cam.x - width / 2) * p;
        const cy = height / 2 + (cam.y - height / 2) * p;
        return { tx: width / 2 - cx * k + driftX, ty: height / 2 - cy * k + driftY, k };
      };
      const farPlane = plane(
        0.45,
        6 * Math.sin(2 * Math.PI * t / 9.7),
        8 * Math.sin(2 * Math.PI * t / 12.3 + 2),
      );
      const nearPlane = plane(
        1.55,
        -9 * Math.sin(2 * Math.PI * t / 8.1 + 1),
        11 * Math.sin(2 * Math.PI * t / 10.9),
      );

      // the incoming view's scale entrance composes with the camera about the element's
      // destination point D: screen' = D + (screen - D) * s, folded into tx/ty/scale
      let worldTx = width / 2 - cam.x * cam.scale;
      let worldTy = height / 2 - cam.y * cam.scale;
      let worldK = cam.scale;
      if (morphEntrance !== null) {
        const s = 0.965 + 0.035 * morphEntrance.p;
        worldTx = morphEntrance.dx * (1 - s) + worldTx * s;
        worldTy = morphEntrance.dy * (1 - s) + worldTy * s;
        worldK = worldK * s;
      }

      await m.page.evaluate(FRAME_APPLY, {
        tx: worldTx,
        ty: worldTy,
        scale: worldK,
        alpha: frame.alpha,
        caption,
        texts: frame.texts,
        cursor,
        ring,
        pose: poseArg,
        supports: supportsArg,
        shine: shineArg,
        shadow: shadowArg,
        spot: spotArg,
        morphImg: morphArg,
        morphPieces: morphPiecesArg,
        backplate: backplateArg,
        far: farPlane,
        near: nearPlane,
      });

      const png = await stableScreenshot(
        m.page as unknown as { screenshot(o: unknown): Promise<Buffer> },
        () => m.page.evaluate(PHASE_MOTION, { tMs: frame.tMs, settle: settleMotion }));
      lastLocalMs = frame.tMs;
      // The film twin of DSX_SHOT_PROBE: dump raw frames so a composition question is
      // answered by looking at frame 140, not by scrubbing a video.
      if (process.env["DSX_FILM_DUMP"] !== undefined) {
        mkdirSync(process.env["DSX_FILM_DUMP"], { recursive: true });
        writeFileSync(join(process.env["DSX_FILM_DUMP"], `f${String(f).padStart(4, "0")}.png`), png);
      }
      frameHashes.push(createHash("sha256").update(png).digest("hex"));
      await encoder.add(png, f);
      opts.onProgress?.(f + 1, limit);

      // the pageerror listener keeps reporting for the scene's whole life - a tap whose
      // handler throws, a write that trips a computed - and "a refused frame is never
      // published" applies to frame 400 as much as to the mount
      if (m.errors.length > 0) {
        errors.push(...m.errors.map((e) => `scene ${frame.index + 1}: ${e}`));
        break;
      }
    }

    if (mounted !== null) await (mounted.page as unknown as { close(): Promise<void> }).close();
    if (errors.length === 0) videoPath = await encoder.finish();
  } catch (e) {
    errors.push(String(e instanceof Error ? e.message : e));
  } finally {
    await context.close();
  }

  return {
    ok: errors.length === 0 && videoPath !== null,
    problems: [], errors, videoPath,
    frameCount: frameHashes.length, frameHashes,
  };
}
