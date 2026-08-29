//
//  keep-inert.test.ts - `keep="true"` hides a subtree without leaving it operable.
//
//  The defect this pins: `mountKeep` faded the subtree out, turned hit-testing off and
//  set `aria-hidden`, which removes it from the accessibility tree and leaves every
//  control in it FOCUSABLE. A sighted keyboard user then tabs through controls that are
//  not on screen, and Chromium logs "Blocked aria-hidden on an element because its
//  descendant retained focus". Measured on the expression canvas: 43 of 61 tab stops
//  inside it were phantoms of exactly this kind, and `keep=` is a kernel word, so the
//  same hole reached every app on the framework.
//
//  `aria-hidden` and `inert` are the two halves of one intent and neither substitutes
//  for the other: `aria-hidden` answers the screen reader, `inert` answers the tab key.
//  Both toggle together or the hidden state is only half true.
//

import { test } from "node:test";
import assert from "node:assert/strict";

import { ReactiveStore, ActionRunner, makeRunEnv, flushEffects } from "@despia/kernel";
import type { XmlNode } from "@despia/compiler/xml";
import type { Registry } from "@despia/compiler/resolve";
import { mountNode, type MountCtx } from "../src/mount.ts";
import { registerElementMotion } from "../src/element-motion.ts";
import { FakeElement } from "./fake-dom.ts";

registerElementMotion();

function mountKept(seed: { [k: string]: unknown }): { el: FakeElement; store: ReactiveStore } {
  const store = new ReactiveStore();
  for (const [k, v] of Object.entries(seed)) store.set(k, v);
  const env = makeRunEnv(store);
  const registry: Registry = { components: {}, globalPool: {}, css: "", schemes: [] };
  const ctx: MountCtx = {
    registry, scheme: "t", owner: "Test", store, runner: new ActionRunner(env), env,
    item: null, disposers: [], slots: null, rowBinding: null,
  };
  const node: XmlNode = {
    tag: "stack",
    attrs: { keep: "true", "visible-if": "shown" },
    children: [{ tag: "text", attrs: { value: "Save" }, children: [], text: "" }],
    text: "",
  };
  const parent = new FakeElement("div");
  mountNode(node, ctx, parent as unknown as ParentNode);
  return { el: parent.childAt(0), store };
}

test("a hidden keep= subtree is inert, so it mints no phantom tab stop", () => {
  const { el } = mountKept({ shown: false });
  assert.equal(el.getAttribute("aria-hidden"), "true", "hidden from the accessibility tree");
  assert.equal(el.inert, true, "and hidden from the tab key, which aria-hidden alone never does");
});

test("a visible keep= subtree is operable", () => {
  const { el } = mountKept({ shown: true });
  assert.equal(el.getAttribute("aria-hidden"), "false");
  assert.equal(el.inert, false, "shown means reachable, not merely painted");
});

test("the two halves toggle together in both directions", () => {
  const { el, store } = mountKept({ shown: true });
  assert.equal(el.inert, false);

  store.set("shown", false);
  flushEffects();
  assert.equal(el.getAttribute("aria-hidden"), "true");
  assert.equal(el.inert, true, "hiding sets both");

  store.set("shown", true);
  flushEffects();
  assert.equal(el.getAttribute("aria-hidden"), "false");
  assert.equal(el.inert, false, "showing clears both");
});
