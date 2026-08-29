//
//  route-chrome.test.ts — the DOM-free ownership half of the web system navigation
//  bar: frame-keyed claims (stamped calls target their exact live frame), the
//  covered-frame read that labels the back affordance with the previous screen's
//  title, and the back-visibility rule.
//

import { test } from "node:test";
import assert from "node:assert/strict";

import { FrameChromeClaims, chromeBackVisibility, frameId } from "../src/route-chrome.ts";

test("frameId accepts only positive integers (the router's opaque ids)", () => {
  assert.equal(frameId(3), 3);
  assert.equal(frameId(0), null);
  assert.equal(frameId(-1), null);
  assert.equal(frameId(1.5), null);
  assert.equal(frameId("2"), null);
  assert.equal(frameId(undefined), null);
});

test("back visibility: deep stacks show it, the root and split presentations hide it", () => {
  assert.equal(chromeBackVisibility(1, false), "hidden");
  assert.equal(chromeBackVisibility(2, false), "visible");
  assert.equal(chromeBackVisibility(2, true), "hidden");
});

test("claims: stamped calls key their exact frame; active() prunes popped frames", () => {
  const claims = new FrameChromeClaims<{ title: string }>();
  claims.claim([1, 2], 1, { title: "Launcher" });
  claims.claim([1, 2], 2, { title: "Flex" });
  assert.deepEqual(claims.active([1, 2]), { title: "Flex" });
  assert.deepEqual(claims.active([1]), { title: "Launcher" });
  // frame 2's claim was pruned with its pop: re-pushing frame 2 starts unclaimed
  assert.equal(claims.active([1, 2]), undefined);
});

test("covered() reads the frame beneath the top: the Back destination's title", () => {
  const claims = new FrameChromeClaims<{ title: string }>();
  claims.claim([1], 1, { title: "Notes" });
  claims.claim([1, 2], 2, { title: "A note" });
  assert.deepEqual(claims.covered([1, 2]), { title: "Notes" });
  assert.equal(claims.covered([1]), undefined, "the root has no Back destination");
  // an unclaimed covered frame answers undefined, so the chrome falls back to "Back"
  claims.release([1, 2], 1);
  assert.equal(claims.covered([1, 2]), undefined);
});
