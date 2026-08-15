//
//  motion.test.ts — the router-motion PURE half (motion.ts): the lane policy, the theme
//  split, the swipe-completion math, and the master-detail split decision. The DOM half
//  (WAAPI animations, the gesture, the split classes) is exercised by build:demo + the
//  screenshot walk. THE SILENCE RULE is pinned here: no motion before `interactive`.
//

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DSX_EASING, DSX_MS, MASTER_DETAIL_DEFAULT, MOTION_CSS,
  autoTheme, dsxRouteFrames, motionFor, splitMasterIndex, swipeCompletes, swipeEnabled,
} from "../src/motion.ts";

const ios = { transition: "ios" as const, swipeBack: true };
const dsx = { transition: "dsx" as const };
const auto = { transition: "auto" as const };

test("no config / transition none / boot-path = no motion ever", () => {
  assert.equal(motionFor(undefined, "ios", 390, true), "none");
  assert.equal(motionFor({ transition: "none" }, "ios", 390, true), "none");
  assert.equal(motionFor({}, "ios", 390, true), "none");
  assert.equal(motionFor(ios, "ios", 390, false), "none"); // the silence rule: not interactive
});

test("auto is neutral DSX on every UA; legacy families require an explicit request", () => {
  assert.equal(autoTheme("Mozilla/5.0 (Linux; Android 15; Pixel)"), "dsx");
  assert.equal(autoTheme("Mozilla/5.0 (iPhone; CPU iPhone OS 26_0)"), "dsx");
  assert.equal(autoTheme("Mozilla/5.0 (X11; Linux x86_64)"), "dsx");
  assert.equal(motionFor(auto, "dsx", 390, true), "dsx");
  assert.equal(motionFor(auto, "md", 390, true), "dsx");
  assert.equal(motionFor(auto, "ios", 390, true), "dsx");
  assert.equal(motionFor(dsx, "ios", 390, true), "dsx");
  assert.equal(motionFor({ transition: "md" }, "dsx", 390, true), "md");
  assert.equal(motionFor({ transition: "ios" }, "dsx", 390, true), "ios");
});

test("the DSX family is a brief geometry-free crossfade and never receives compatibility decoration", () => {
  assert.equal(DSX_MS, 160);
  assert.equal(DSX_EASING, "ease-out");
  assert.deepEqual(dsxRouteFrames("enter"), [{ opacity: "0" }, { opacity: "1" }]);
  assert.deepEqual(dsxRouteFrames("exit"), [{ opacity: "1" }, { opacity: "0" }]);
  for (const frame of [...dsxRouteFrames("enter"), ...dsxRouteFrames("exit")]) {
    assert.ok(!("transform" in frame), "neutral route motion must never move or scale layout");
  }
  assert.ok(MOTION_CSS.includes(".dsx-motion-top.dsx-motion-ios::before"));
  assert.ok(!MOTION_CSS.includes(".dsx-motion-top.dsx-motion-dsx::before"));
});

test("the wide lane defaults to none, 'same' keeps the family", () => {
  assert.equal(motionFor(ios, "ios", MASTER_DETAIL_DEFAULT, true), "none");
  assert.equal(motionFor({ ...ios, wide: "same" }, "ios", 1280, true), "ios");
  assert.equal(motionFor({ ...dsx, wide: "same" }, "dsx", 1280, true), "dsx");
  assert.equal(motionFor({ ...ios, masterDetailBreakpoint: 700 }, "ios", 699, true), "ios");
  assert.equal(motionFor({ ...ios, masterDetailBreakpoint: 700 }, "ios", 700, true), "none");
});

test("swipe completes past half the width, or on a flick (the verified F7 rule)", () => {
  assert.equal(swipeCompletes(200, 390, 800), true);   // > width/2 — however slow
  assert.equal(swipeCompletes(180, 390, 800), false);  // short + slow springs back
  assert.equal(swipeCompletes(60, 390, 200), true);    // a real flick (<300ms, past the floor)
  assert.equal(swipeCompletes(60, 390, 350), false);   // same travel, too slow to be a flick
  assert.equal(swipeCompletes(12, 390, 100), false);   // a twitch is not a flick (24px floor)
  assert.equal(swipeCompletes(-30, 390, 100), false);
  assert.equal(swipeCompletes(50, 0, 100), false);
});

test("swipe is mobile-ios-lane only, with something to pop", () => {
  assert.equal(swipeEnabled(ios, "ios", 390, 2), true);
  assert.equal(swipeEnabled(ios, "ios", 390, 1), false);              // root
  assert.equal(swipeEnabled(ios, "ios", 1280, 3), false);             // wide lane
  assert.equal(swipeEnabled({ transition: "md", swipeBack: true }, "md", 390, 2), false); // md motion
  assert.equal(swipeEnabled({ transition: "auto", swipeBack: true }, "dsx", 390, 2), false);
  assert.equal(swipeEnabled({ transition: "dsx", swipeBack: true }, "dsx", 390, 2), false);
  assert.equal(swipeEnabled({ ...ios, swipeBack: false }, "ios", 390, 2), false);
  assert.equal(swipeEnabled(undefined, "ios", 390, 2), false);
});

test("the split pins the deepest master BELOW the top, wide lane only", () => {
  assert.equal(splitMasterIndex([true, false, false], 1280, 960), 0);
  assert.equal(splitMasterIndex([false, true, false], 1280, 960), 1); // deepest below top
  assert.equal(splitMasterIndex([true, false, true], 1280, 960), 0);  // a top master is just a page
  assert.equal(splitMasterIndex([true], 1280, 960), -1);              // master alone fills the window
  assert.equal(splitMasterIndex([true, false], 390, 960), -1);        // mobile lane: no split
  assert.equal(splitMasterIndex([false, false], 1280, 960), -1);
});

test("master-detail geometry is writing-direction agnostic", () => {
  assert.match(MOTION_CSS, /inset-inline-start:\s*0/);
  assert.match(MOTION_CSS, /inset-inline-end:\s*auto/);
  assert.match(MOTION_CSS, /border-inline-end:/);
  assert.match(MOTION_CSS, /\.dsx-split \.dsx-detail \{ inset-inline-start:/);
  assert.doesNotMatch(MOTION_CSS, /\.dsx-split \.dsx-detail \{ left:/);
  assert.doesNotMatch(MOTION_CSS, /border-right:/);
});
