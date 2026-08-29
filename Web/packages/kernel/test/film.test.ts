//
//  film.test.ts - the film timeline against its corpus (Conformance/film/timeline.json).
//
//  The corpus pins the laws determinism rests on; this runner executes them on the TS
//  kernel. Eased camera moves are asserted only at their endpoints here - the curve between
//  them is Conformance/motion's law, and re-pinning it would be a second opinion about it.
//

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import {
  cameraAt, filmFrameAt, filmFrameCount, floatAt, poseAt, sceneIndexAt, validateFilm,
  POSE_HOME, type CameraMove, type CameraState, type Film, type FilmPoseMove, type FilmPoseState,
} from "../src/film.ts";
import { parseMotion } from "../src/motion.ts";

const corpusPath = resolve(import.meta.dirname, "../../../../Conformance/film/timeline.json");
const corpus = JSON.parse(readFileSync(corpusPath, "utf8")) as {
  film: Film & { scenes: Array<Film["scenes"][number] & { camera: Array<{ ease: string }> }> };
  frameCount: number;
  sceneIndex: Array<{ name: string; tMs: number; expect: number }>;
  sceneAlpha: Array<{ name: string; tMs: number; expect: number }>;
  tapAttribution: { frameMs: number; cases: Array<{ name: string; tMs: number; expectTaps: number }> };
  camera: {
    home: CameraState;
    moves: Array<Omit<CameraMove, "ease"> & { ease: string }>;
    cases: Array<{ name: string; tMs: number; expect: CameraState }>;
    easedEndpoints: {
      move: Omit<CameraMove, "ease"> & { ease: string };
      atStart: CameraState; atEnd: CameraState;
    };
  };
  pose: {
    moves: Array<Omit<FilmPoseMove, "ease"> & { ease: string }>;
    cases: Array<{ name: string; tMs: number; expect: FilmPoseState }>;
  };
  float: {
    cases: Array<{ name: string; tMs: number; expectY?: number; expectTurn?: number;
                   expectYZero?: boolean }>;
  };
  cut: {
    mutate: { scene: number; set: { [k: string]: unknown } };
    cases: Array<{ name: string; tMs: number; expect: number }>;
  };
  writes: {
    frameMs: number;
    mutate: { scene: number; set: { [k: string]: unknown } };
    cases: Array<{ name: string; tMs: number; expect: Array<{ name: string; value: unknown }> }>;
  };
  focus: {
    mutate: { scene: number; set: { [k: string]: unknown } };
    cases: Array<{ name: string; tMs: number; expectNull?: boolean; expectAlpha?: number;
                   expectTarget?: string }>;
  };
  morph: {
    mutate: { scene: number; set: { [k: string]: unknown } };
    cases: Array<{ name: string; tMs: number; expectNull?: boolean; expectP?: number;
                   expectAlpha?: number }>;
  };
  validation: Array<{
    name: string;
    mutate: { scene: number; set: { [k: string]: unknown } } | null;
    slot?: string;
    stretch?: { durationMs: number; lastSceneForMs: number };
    expectCodes: string[];
  }>;
};

/** The corpus stores easings as words; the kernel takes MotionSpecs. One bridge, here. */
function concrete(move: Omit<CameraMove, "ease"> & { ease: string }): CameraMove {
  return { ...move, ease: parseMotion(move.ease, String(move.forMs / 1000)) };
}

function corpusFilm(): Film {
  const film = JSON.parse(JSON.stringify(corpus.film)) as Film;
  for (const scene of film.scenes) {
    scene.camera = scene.camera.map((m) =>
      ({ ...m, ease: parseMotion(m.ease as unknown as string, String(m.forMs / 1000)) }));
  }
  return film;
}

/** Apply a corpus mutation, then concrete any ease words the mutation introduced - the
 *  corpus stores words, the kernel takes MotionSpecs, and the bridge stays in this file. */
function mutatedFilm(mutate: { scene: number; set: { [k: string]: unknown } }): Film {
  const film = corpusFilm();
  const scene = film.scenes[mutate.scene]!;
  Object.assign(scene as object, mutate.set);
  const concreteEase = <T extends { forMs: number; ease: unknown }>(m: T): T =>
    typeof m.ease === "string" ? { ...m, ease: parseMotion(m.ease, String(m.forMs / 1000)) } : m;
  scene.camera = scene.camera.map(concreteEase);
  scene.poses = scene.poses.map(concreteEase);
  scene.tweens = scene.tweens.map(concreteEase);
  if (scene.morph !== null) scene.morph = concreteEase(scene.morph);
  return film;
}

test("film: the frame count is exact", () => {
  assert.equal(filmFrameCount(corpusFilm()), corpus.frameCount);
});

test("film: scene selection at boundaries", () => {
  const film = corpusFilm();
  for (const row of corpus.sceneIndex) {
    assert.equal(sceneIndexAt(film, row.tMs), row.expect, row.name);
  }
});

test("film: scene enter/leave alpha", () => {
  const film = corpusFilm();
  for (const row of corpus.sceneAlpha) {
    const frame = filmFrameAt(film, row.tMs, 1000 / film.fps);
    assert.ok(Math.abs(frame.alpha - row.expect) < 1e-9, `${row.name}: ${frame.alpha}`);
  }
});

test("film: a tap belongs to exactly one frame", () => {
  const film = corpusFilm();
  for (const row of corpus.tapAttribution.cases) {
    const frame = filmFrameAt(film, row.tMs, corpus.tapAttribution.frameMs);
    assert.equal(frame.taps.length, row.expectTaps, row.name);
  }
});

test("film: camera hold-then-move composition", () => {
  const moves = corpus.camera.moves.map(concrete);
  for (const row of corpus.camera.cases) {
    const got = cameraAt(moves, row.tMs, corpus.camera.home);
    for (const axis of ["x", "y", "scale"] as const) {
      assert.ok(Math.abs(got[axis] - row.expect[axis]) < 1e-9,
        `${row.name}: ${axis} = ${got[axis]}, expected ${row.expect[axis]}`);
    }
  }
});

test("film: an eased move is exact at its endpoints", () => {
  const spec = corpus.camera.easedEndpoints;
  const moves = [concrete(spec.move)];
  const start = cameraAt(moves, spec.move.atMs, corpus.camera.home);
  const end = cameraAt(moves, spec.move.atMs + spec.move.forMs, corpus.camera.home);
  assert.deepEqual(start, spec.atStart);
  assert.deepEqual(end, spec.atEnd);
  // and strictly between them the move is neither state - it is MOVING
  const mid = cameraAt(moves, spec.move.atMs + spec.move.forMs / 2, corpus.camera.home);
  assert.notDeepEqual(mid, spec.atStart);
  assert.notDeepEqual(mid, spec.atEnd);
});

test("film: validation refuses what the corpus says it refuses", () => {
  for (const row of corpus.validation) {
    const film = row.mutate != null ? mutatedFilm(row.mutate) : corpusFilm();
    if (row.stretch !== undefined) {
      film.durationMs = row.stretch.durationMs;
      film.scenes[film.scenes.length - 1]!.forMs = row.stretch.lastSceneForMs;
    }
    const codes = validateFilm(film, row.slot).map((p) => p.code).sort();
    assert.deepEqual(codes, [...row.expectCodes].sort(), row.name);
  }
});

test("film: pose hold-then-move composition over six axes", () => {
  const moves: FilmPoseMove[] = corpus.pose.moves.map((m) =>
    ({ ...m, ease: parseMotion(m.ease, String(m.forMs / 1000)) }));
  for (const row of corpus.pose.cases) {
    const got = poseAt(moves, row.tMs, POSE_HOME);
    for (const axis of ["turn", "tilt", "roll", "x", "y", "scale"] as const) {
      assert.ok(Math.abs(got[axis] - row.expect[axis]) < 1e-9,
        `${row.name}: ${axis} = ${got[axis]}, expected ${row.expect[axis]}`);
    }
  }
});

test("film: the incoming scene's cut owns both edges of its boundary", () => {
  const film = mutatedFilm(corpus.cut.mutate);
  for (const row of corpus.cut.cases) {
    const frame = filmFrameAt(film, row.tMs, 1000 / film.fps);
    assert.ok(Math.abs(frame.alpha - row.expect) < 1e-9,
      `${row.name}: alpha = ${frame.alpha}, expected ${row.expect}`);
  }
});

test("film: state writes sample exactly as the corpus pins them", () => {
  const film = mutatedFilm(corpus.writes.mutate);
  for (const row of corpus.writes.cases) {
    const frame = filmFrameAt(film, row.tMs, corpus.writes.frameMs);
    assert.deepEqual(frame.writes, row.expect, row.name);
  }
});

test("film: the spotlight follows the caption envelope", () => {
  const film = mutatedFilm(corpus.focus.mutate);
  for (const row of corpus.focus.cases) {
    const frame = filmFrameAt(film, row.tMs, 1000 / film.fps);
    if (row.expectNull === true) { assert.equal(frame.focus, null, row.name); continue; }
    assert.notEqual(frame.focus, null, row.name);
    if (row.expectAlpha !== undefined) {
      assert.ok(Math.abs(frame.focus!.alpha - row.expectAlpha) < 1e-9,
        `${row.name}: alpha = ${frame.focus!.alpha}`);
    }
    if (row.expectTarget !== undefined) assert.equal(frame.focus!.target, row.expectTarget, row.name);
  }
});

test("film: the hero morph's progress law, and the hard boundary it implies", () => {
  const film = mutatedFilm(corpus.morph.mutate);
  for (const row of corpus.morph.cases) {
    const frame = filmFrameAt(film, row.tMs, 1000 / film.fps);
    if (row.expectAlpha !== undefined) {
      assert.ok(Math.abs(frame.alpha - row.expectAlpha) < 1e-9,
        `${row.name}: alpha = ${frame.alpha}`);
      continue;
    }
    if (row.expectNull === true) { assert.equal(frame.morph, null, row.name); continue; }
    assert.notEqual(frame.morph, null, row.name);
    assert.ok(Math.abs(frame.morph!.p - row.expectP!) < 1e-9, `${row.name}: p = ${frame.morph!.p}`);
  }
});

test("film: the idle float is a pure function of time", () => {
  for (const row of corpus.float.cases) {
    const got = floatAt(row.tMs);
    if (row.expectY !== undefined) assert.ok(Math.abs(got.y - row.expectY) < 1e-9, row.name);
    if (row.expectTurn !== undefined) assert.ok(Math.abs(got.turn - row.expectTurn) < 1e-9, row.name);
    if (row.expectYZero === true) assert.ok(Math.abs(got.y) < 1e-9, row.name);
  }
  assert.deepEqual(floatAt(4321), floatAt(4321), "determinism: same instant, same drift");
});
