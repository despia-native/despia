//
//  film.test.ts - the film pipeline's gates.
//
//  Three layers, three kinds of proof: the READER refuses what is outside the closed grammar
//  (an ignored attribute is how two renders of one document stop agreeing); the MUXER writes
//  a structurally valid WebM; and the DRIVER is deterministic - the Phase 0 gate is two
//  renders of the same fixture producing identical frame hashes, which is the whole reason
//  the clock is paused and advanced by exact frame periods.
//

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { readFilmDocument, FilmDocumentError, parseTimeMs } from "../src/film-document.ts";
import { muxWebm } from "../src/webm.ts";
import { renderFilm } from "../src/film-render.ts";
import { launchShotBrowser } from "../src/shot-browser.ts";
import { loadConfig } from "../src/config.ts";

const webRoot = resolve(import.meta.dirname, "../../..");
const fixture = resolve(webRoot, "../Conformance/film/fixture");
const composition = readFileSync(
  resolve(fixture, "marketing/keto-launch/composition.dsx"), "utf8");

// ── the reader ───────────────────────────────────────────────────────────────────────

test("film reader: the demo composition parses to the declared shape", () => {
  const film = readFilmDocument(composition);
  assert.equal(film.id, "keto-launch");
  assert.equal(film.durationMs, 18_400);
  assert.equal(film.fps, 30);
  assert.deepEqual(film.format, { width: 1080, height: 1920 });
  assert.equal(film.scenes.length, 5);
  assert.equal(film.theme.scheme, "dark");
  // scene starts are DERIVED and contiguous
  assert.equal(film.scenes[1]!.atMs, 1800);
  assert.equal(film.scenes[4]!.atMs, 16_200);
  // the state journey: the morning preset mounts, and the day arrives as STAGGERED tweens
  // (a choreography, not one snap) with the ketosis flip as its own designed beat
  assert.deepEqual(film.states[0]!.vars["calories"], 210);
  assert.equal(film.scenes[1]!.tweens.length, 7);
  assert.deepEqual(film.scenes[1]!.sets, [{ atMs: 3000, name: "ketone", value: 1.8 }]);
  assert.deepEqual(
    { from: film.scenes[1]!.tweens[0]!.from, to: film.scenes[1]!.tweens[0]!.to,
      round: film.scenes[1]!.tweens[0]!.round },
    { from: 210, to: 1480, round: true });
  // the commercial grammar: hard cuts, the frameless product shot
  assert.equal(film.scenes[1]!.cut, "hard");
  assert.equal(film.scenes[0]!.cut, "fade");
  assert.equal(film.scenes[3]!.frame, "none");
  assert.equal(film.scenes[3]!.deviceWidth, 0.78);
  // the spotlight and the hero morph
  assert.equal(film.scenes[2]!.focus[0]!.target, "#ketoCard");
  assert.equal(film.scenes[3]!.morph!.target, "#ketoCard");
  assert.equal(film.scenes[3]!.morph!.forMs, 700);
  // the supporting frames: their own documents and states, depth-ordered behind the primary
  assert.deepEqual(film.scenes[1]!.frames, [
    { document: "Dashboard", state: "evening", width: 0.3, x: 0.1, y: 0.36, depth: -1 },
    { document: "Dashboard", state: "morning", width: 0.26, x: 0.91, y: 0.58, depth: -1 },
  ]);
  assert.deepEqual(film.scenes[0]!.frames, []);
});

test("film reader: <apply> compiles to the write law, and a spring owns its window", () => {
  const film = readFilmDocument(`<film id="x" duration="1s" fps="30">
  <state name="s"><value var="a">1</value><value global="g">2</value></state>
  <scene for="1s" document="D">
    <apply at="0.5s" state="s"/>
    <pose at="0s" for="0.6s" scale="1.1" ease="spring"/>
  </scene>
</film>`);
  // one set per preset row, all attributed to the apply's instant; globals prefixed the
  // way the state door reads them
  assert.deepEqual(film.scenes[0]!.sets, [
    { atMs: 500, name: "a", value: 1 },
    { atMs: 500, name: "global.g", value: 2 },
  ]);
  // a spring's settle lands exactly on for=, so hold-then-move never snaps at the boundary
  const pose = film.scenes[0]!.poses[0]!;
  assert.equal(pose.ease.kind, "spring");
  assert.ok(Math.abs(pose.ease.durationMs - pose.forMs) < 1);
});

test("film reader: durations demand a unit", () => {
  assert.equal(parseTimeMs("2.5s", "x"), 2500);
  assert.equal(parseTimeMs("300ms", "x"), 300);
  assert.throws(() => parseTimeMs("2.5", "x"), FilmDocumentError);
});

test("film reader: the grammar is closed", () => {
  const refusals: Array<[string, string]> = [
    ["an unknown film attribute",
      `<film id="x" duration="1s" fps="30" wat="1"><scene for="1s"><text role="hook">t</text></scene></film>`],
    ["an unknown scene layer",
      `<film id="x" duration="1s" fps="30"><scene for="1s"><sparkles/></scene></film>`],
    ["a coordinate tap",
      `<film id="x" duration="1s" fps="30"><scene for="1s" document="D"><tap at="0.5s" target="120,80"/></scene></film>`],
    ["a tap with no mounted document",
      `<film id="x" duration="1s" fps="30"><scene for="1s"><text role="hook">t</text><tap at="0.5s" target="#b"/></scene></film>`],
    ["a camera ease outside the motion words",
      `<film id="x" duration="1s" fps="30"><scene for="1s" document="D"><camera at="0s" for="0.5s" zoom="2" ease="bouncy"/></scene></film>`],
    ["a text role outside the vocabulary",
      `<film id="x" duration="1s" fps="30"><scene for="1s"><text role="shout">t</text></scene></film>`],
    ["a cut outside fade|hard",
      `<film id="x" duration="1s" fps="30"><scene for="1s" cut="smash"><text role="hook">t</text></scene></film>`],
    ["a frameless scene with no document",
      `<film id="x" duration="1s" fps="30"><scene for="1s" frame="none"><text role="hook">t</text></scene></film>`],
    ["width= on a device scene (the chassis is sized by device=)",
      `<film id="x" duration="1s" fps="30"><scene for="1s" document="D" width="80%"/></film>`],
    ["device= on a frameless scene (the component is sized by width=)",
      `<film id="x" duration="1s" fps="30"><scene for="1s" document="D" frame="none" device="80%"/></film>`],
    ["a set with no mounted document",
      `<film id="x" duration="1s" fps="30"><scene for="1s"><text role="hook">t</text><set at="0.5s" var="n" to="1"/></scene></film>`],
    ["a tween of a non-number",
      `<film id="x" duration="1s" fps="30"><scene for="1s" document="D"><tween at="0s" for="0.5s" var="n" from="zero" to="1"/></scene></film>`],
    ["a tween round outside true|false",
      `<film id="x" duration="1s" fps="30"><scene for="1s" document="D"><tween at="0s" for="0.5s" var="n" from="0" to="1" round="yes"/></scene></film>`],
    ["an apply naming no declared state",
      `<film id="x" duration="1s" fps="30"><scene for="1s" document="D"><apply at="0.5s" state="ghost"/></scene></film>`],
    ["an apply with no mounted document",
      `<film id="x" duration="1s" fps="30"><state name="s"><value var="a">1</value></state><scene for="1s"><text role="hook">t</text><apply at="0.5s" state="s"/></scene></film>`],
    ["a focus with no mounted document",
      `<film id="x" duration="1s" fps="30"><scene for="1s"><text role="hook">t</text><focus at="0.2s" for="0.5s" target="#a"/></scene></film>`],
    ["a coordinate focus target",
      `<film id="x" duration="1s" fps="30"><scene for="1s" document="D"><focus at="0.2s" for="0.5s" target="20,30"/></scene></film>`],
    ["a second morph on one scene",
      `<film id="x" duration="2s" fps="30"><scene for="1s" document="D"/><scene for="1s" document="D"><morph target="#a" for="0.3s"/><morph target="#b" for="0.3s"/></scene></film>`],
    ["a supporting frame with no document of its own",
      `<film id="x" duration="1s" fps="30"><scene for="1s" document="D"><frame width="30%"/></scene></film>`],
    ["a supporting frame in a scene with no primary mount",
      `<film id="x" duration="1s" fps="30"><scene for="1s"><text role="hook">t</text><frame document="D"/></scene></film>`],
    ["a supporting frame's width outside the percent grammar",
      `<film id="x" duration="1s" fps="30"><scene for="1s" document="D"><frame document="E" width="300px"/></scene></film>`],
    ["a supporting frame's depth outside back|front",
      `<film id="x" duration="1s" fps="30"><scene for="1s" document="D"><frame document="E" depth="middle"/></scene></film>`],
    ["a supporting frame naming no declared state",
      `<film id="x" duration="1s" fps="30"><scene for="1s" document="D"><frame document="E" state="ghost"/></scene></film>`],
    ["a scene naming no declared state",
      `<film id="x" duration="1s" fps="30"><scene for="1s" document="D" state="ghost"/></film>`],
  ];
  for (const [name, source] of refusals) {
    assert.throws(() => readFilmDocument(source), FilmDocumentError, name);
  }
});

// ── the muxer ────────────────────────────────────────────────────────────────────────

test("webm: the container is structurally a WebM", () => {
  const bytes = muxWebm([
    { data: new Uint8Array([1, 2, 3]), timecodeMs: 0, key: true },
    { data: new Uint8Array([4, 5]), timecodeMs: 33, key: false },
  ], 320, 640, 66);
  // EBML magic
  assert.deepEqual([...bytes.subarray(0, 4)], [0x1a, 0x45, 0xdf, 0xa3]);
  const text = Buffer.from(bytes).toString("latin1");
  assert.ok(text.includes("webm"), "doctype");
  assert.ok(text.includes("V_VP9"), "codec id");
  assert.throws(() => muxWebm([{ data: new Uint8Array([1]), timecodeMs: 0, key: false }], 1, 1, 1),
    /keyframe/);
});

// ── the driver: determinism is the Phase 0 gate ──────────────────────────────────────

test("film driver: two renders produce identical frames, and the real app flips on tap",
  { timeout: 300_000 }, async () => {
  const film = readFilmDocument(composition);
  const config = loadConfig(fixture);
  const browser = await launchShotBrowser();
  const outDir = join(tmpdir(), "dsx-film-test");
  try {
    const run = () => renderFilm(browser, config, film, {
      webRoot, projectRoot: fixture, outDir, encoder: "webm", frameLimit: 8,
    });
    const a = await run();
    assert.deepEqual(a.errors, []);
    assert.equal(a.ok, true);
    assert.equal(a.frameCount, 8);
    const b = await run();
    assert.deepEqual(b.frameHashes, a.frameHashes,
      "the same composition must render the same bytes - determinism is the contract CI, caching and store review all rest on");
    // and the file is a WebM
    const head = readFileSync(a.videoPath!).subarray(0, 4);
    assert.deepEqual([...head], [0x1a, 0x45, 0xdf, 0xa3]);
  } finally {
    await (browser as unknown as { close(): Promise<void> }).close();
  }
});

test("film driver: the frameless shot springs, takes state writes, spotlights, morphs, and hard-cuts - deterministically",
  { timeout: 300_000 }, async () => {
  // a tiny commercial exercising the whole commercial grammar: a frameless component with
  // intrinsic height, a spring entrance, a tween through the app's real store, a spotlight,
  // then a HARD CUT whose hero morph carries the card into a second mount - at 10fps so 17
  // frames cross the boundary cheaply
  const tiny = readFilmDocument(`<film id="card" duration="2.4s" fps="10" size="540x960">
  <theme bg="#0b0d12" ink="#f4f6fb" accent="#34d399" scheme="dark"/>
  <state name="card"><value var="ketoneTenths">2</value></state>
  <state name="high"><value var="ketoneTenths">18</value></state>
  <scene for="1.4s" document="KetoCard" state="card" frame="none" width="80%">
    <frame document="KetoCard" state="high" width="28%" x="14%" y="38%"/>
    <pose at="0s" for="0s" scale="0.6"/>
    <pose at="0.1s" for="0.5s" scale="1" ease="spring"/>
    <apply at="0.2s" state="high"/>
    <focus at="0.4s" for="0.7s" target="#ketoCard"/>
  </scene>
  <scene for="1s" document="KetoCard" state="high" frame="none" width="66%" cut="hard">
    <morph target="#ketoCard" for="0.4s"/>
    <tween at="0.5s" for="0.4s" var="ketoneTenths" from="18" to="21" round="true"/>
  </scene>
</film>`);
  const config = loadConfig(fixture);
  const browser = await launchShotBrowser();
  const outDir = join(tmpdir(), "dsx-film-frameless-test");
  try {
    const run = () => renderFilm(browser, config, tiny, {
      webRoot, projectRoot: fixture, outDir, encoder: "webm", frameLimit: 20,
    });
    const a = await run();
    assert.deepEqual(a.errors, []);
    assert.equal(a.ok, true);
    assert.equal(a.frameCount, 20);
    const b = await run();
    assert.deepEqual(b.frameHashes, a.frameHashes,
      "the frameless + state-write path must be as deterministic as the device path");
  } finally {
    await (browser as unknown as { close(): Promise<void> }).close();
  }
});

test("film driver: the APP's own motion plays, phased to the film clock (R33)",
  { timeout: 300_000 }, async () => {
  // one scene, no film-driven motion at all after the mount - no pose, no camera, no
  // float, no atmosphere (the parallax planes drift by design), and ONE <set>. Every frame-to-frame difference is therefore the application's
  // own transition (KetoCard's <progress> fill carries one), which is exactly what the
  // film used to suppress by forcing reduced motion and finishing every animation.
  const film = readFilmDocument(`<film id="motion" duration="1.2s" fps="10" size="540x960">
  <theme bg="#0b0d12" ink="#f4f6fb" accent="#34d399" scheme="dark"/>
  <state name="low"><value var="ketoneTenths">2</value></state>
  <scene for="1.2s" document="KetoCard" state="low" frame="none" width="80%" float="false"
         glow="none">
    <set at="0.3s" var="ketoneTenths" to="18"/>
  </scene>
</film>`);
  const config = loadConfig(fixture);
  const browser = await launchShotBrowser();
  const outDir = join(tmpdir(), "dsx-film-motion-test");
  try {
    const run = await renderFilm(browser, config, film, {
      webRoot, projectRoot: fixture, outDir, encoder: "webm", frameLimit: 12,
    });
    assert.deepEqual(run.errors, []);
    const h = run.frameHashes;
    // before the write nothing moves: a film with no tracks is a still frame
    assert.equal(h[1], h[2], "no film track means no motion before the write");
    // the write lands on frame 3 and the app's own transition is IN FLIGHT on frame 4 -
    // the frame that used to be identical to its neighbours
    assert.notEqual(h[3], h[4], "the app's own transition must produce in-between frames");
    assert.notEqual(h[4], h[5], "and keep producing them while it runs");
    // and it SETTLES: a transition phased to the film clock ends, it does not creep
    assert.equal(h[9], h[10], "the app's transition settles and stays settled");
    assert.equal(h[10], h[11], "still settled a frame later");
    // determinism holds with app motion live
    const again = await renderFilm(browser, config, film, {
      webRoot, projectRoot: fixture, outDir, encoder: "webm", frameLimit: 12,
    });
    assert.deepEqual(again.frameHashes, h, "app motion must be as deterministic as film motion");
  } finally {
    await (browser as unknown as { close(): Promise<void> }).close();
  }
});

test("film driver: an unlawful film refuses before any browser work", async () => {
  const film = readFilmDocument(composition);
  film.scenes[0]!.texts = [];
  film.scenes[0]!.document = "";
  const outcome = await renderFilm(null, loadConfig(fixture), film, {
    webRoot, projectRoot: fixture, outDir: "/tmp/never", encoder: "webm",
  });
  assert.equal(outcome.ok, false);
  assert.ok(outcome.problems.some((p) => p.code === "static"), "G-static bites");
});
