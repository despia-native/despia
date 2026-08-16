//
//  route-module.test.ts — deterministic frame-scoped system chrome ownership.
//  These are the DOM-free rules consumed by the route facet; real button keyboard
//  activation is pinned separately in keyboard.test.ts and browser history seeding
//  in router.test.ts.
//

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { LAYER_STATEMENT } from "../../compiler/src/cssmap.ts";
import { FrameChromeClaims, chromeBackVisibility, frameId } from "../src/route-chrome.ts";
import { ROUTE_CHROME_CSS, ROUTE_CHROME_STYLE_ID } from "../src/route-chrome-style.ts";

const routeFacetSource = readFileSync(new URL(
  "../../../../../ClosedSource/DSX/Modules/Mandatory/Routing/web/index.js",
  import.meta.url,
), "utf8");

test("route chrome defaults stay in the weak layer with complete author override handles", () => {
  assert.ok(ROUTE_CHROME_CSS.startsWith("@layer dsx-elements {"));
  assert.ok(!ROUTE_CHROME_CSS.includes("!important"));
  for (const selector of [
    ".dsx-route-chrome",
    ".dsx-route-back",
    ".dsx-route-title",
    ".dsx-route-spacer",
  ]) {
    assert.ok(ROUTE_CHROME_CSS.includes(`:where(${selector}`), `zero-specificity default: ${selector}`);
  }
  for (const token of [
    "--dsx-route-height",
    "--dsx-route-large-height",
    "--dsx-route-surface",
    "--dsx-route-separator",
    "--dsx-route-shadow",
    "--dsx-route-blur",
    "--dsx-route-accent",
    "--dsx-route-title-size",
    "--dsx-route-large-title-size",
  ]) {
    assert.ok(ROUTE_CHROME_CSS.includes(token), `live override token: ${token}`);
  }
  assert.ok(
    ROUTE_CHROME_CSS.includes("box-shadow: var(--dsx-route-shadow, none)"),
    "neutral chrome uses the separator for hierarchy; elevation is an explicit author choice",
  );

  const layers: string[] = String(LAYER_STATEMENT).match(/dsx-[a-z-]+/g) ?? [];
  const defaults = layers.indexOf("dsx-elements");
  for (const authorLayer of ["dsx-theme", "dsx-sheets", "dsx-inline", "dsx-attrs"]) {
    assert.ok(defaults >= 0 && defaults < layers.indexOf(authorLayer), `${authorLayer} outranks defaults`);
  }
});

test("route chrome runtime exposes state without inline presentation", () => {
  assert.ok(routeFacetSource.includes("ROUTE_CHROME_CSS"));
  assert.ok(routeFacetSource.includes("ROUTE_CHROME_STYLE_ID"));
  assert.ok(routeFacetSource.includes('bar.className = "dsx-route-chrome"'));
  for (const state of ["data-dsx-large", "data-dsx-split", "data-dsx-back"]) {
    assert.ok(routeFacetSource.includes(state), `CSS-addressable state: ${state}`);
  }
  assert.doesNotMatch(routeFacetSource, /style\.cssText/);
  assert.doesNotMatch(routeFacetSource, /\b(?:bar|barBack|barTitle)\.style(?:\.|\[)/);
  assert.equal(ROUTE_CHROME_STYLE_ID, "dsx-route-chrome-style");
});

test("cold detail and root claims are correct even when delivered in reverse", () => {
  const claims = new FrameChromeClaims<{ title: string }>();
  const live = [101, 202];

  claims.claim(live, 202, { title: "Flex layout" });
  claims.claim(live, 101, { title: "DSX demo" });

  assert.deepEqual(claims.active(live), { title: "Flex layout" });
  assert.equal(chromeBackVisibility(live.length, false), "visible");
});

test("covered, popped, and modal claims cannot leak onto the top frame", () => {
  const claims = new FrameChromeClaims<{ title: string }>();
  claims.claim([101, 202], 101, { title: "Covered" });
  claims.claim([101, 202], 202, { title: "Top" });
  assert.deepEqual(claims.active([101, 202]), { title: "Top" });

  // Back prunes the popped detail and reclaims root chrome.
  assert.deepEqual(claims.active([101]), { title: "Covered" });
  assert.equal(chromeBackVisibility(1, false), "hidden");

  assert.equal(claims.claim([101], 202, { title: "Popped late" }), null);
  assert.equal(claims.claim([101], 999, { title: "Modal" }), null);
  assert.deepEqual(claims.active([101]), { title: "Covered" });
});

test("frame-scoped release and unstamped public calls target the intended owner", () => {
  const claims = new FrameChromeClaims<{ title: string }>();
  const live = [11, 12];
  claims.claim(live, 11, { title: "Root" });
  claims.claim(live, undefined, { title: "Public top" });
  assert.deepEqual(claims.active(live), { title: "Public top" });

  assert.equal(claims.release(live, 11), 11);
  assert.deepEqual(claims.active(live), { title: "Public top" });
  assert.equal(claims.release(live, undefined), 12);
  assert.equal(claims.active(live), undefined);
});

test("frame ids normalize JSON numbers and split layouts suppress duplicate Back", () => {
  assert.equal(frameId(7), 7);
  assert.equal(frameId("7"), null, "authored strings cannot impersonate an internal frame stamp");
  assert.equal(frameId(true), null);
  assert.equal(frameId(7.5), null);
  assert.equal(frameId("not-a-frame"), null);
  assert.equal(chromeBackVisibility(2, true), "hidden");
});
