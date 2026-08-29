//
//  tooltip.test.ts — the tooltip= / tooltipSide= universal hint attribute
//  (design-system.md Wave 3 (c)1; the shared law: Conformance/input/tooltip.json).
//  The contract under test: the corpus resolver + lifecycle run verbatim, and the
//  renderer wires them as a real `role="tooltip"` node the element references via
//  aria-describedby the WHOLE time it is mounted (assistive tech reads the text with
//  or without a pointer), while the visual reveal is gated on `(hover: hover)` plus a
//  non-touch pointer — hover intent is delayed, keyboard (focus-visible) focus is
//  immediate, Escape/pointer-out/blur dismiss, and touch never fires it (Article 7).
//
//  Same in-process fake-DOM harness as hover.test.ts, extended with a body, a
//  recording document event surface, and settable client rects for placement.
//

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

import { ReactiveStore, ActionRunner, makeRunEnv } from "@despia-native/kernel";
import type { XmlNode } from "@despia-native/compiler/xml";
import type { Registry } from "@despia-native/compiler/resolve";
import {
  TooltipLifecycle, resolveTooltip, mountNode, TOOLTIP_INTENT_DELAY_MS,
  type TooltipAction, type MountCtx,
} from "../src/mount.ts";

type ResolveCase = {
  name: string;
  tooltip?: string;
  tooltipSide?: string;
  expect: { text: string; side: string; described: boolean } | null;
};
type LifecycleEvent = {
  type: "hoverStart" | "hoverEnd" | "focus" | "blur" | "escape" | "unmount";
  hoverCapable?: boolean;
};
type LifecycleCase = {
  name: string;
  events: LifecycleEvent[];
  expect: TooltipAction[];
  expectVisible: boolean;
};
const corpus = JSON.parse(readFileSync(
  new URL("../../../../Conformance/input/tooltip.json", import.meta.url), "utf8",
)) as { version: number; resolve: ResolveCase[]; lifecycle: LifecycleCase[] };

type Rect = { left: number; right: number; top: number; bottom: number; width: number; height: number };

class FakeClassList {
  add(): void {}
  remove(): void {}
  toggle(): void {}
  contains(): boolean { return false; }
}

class FakeElement {
  tagName: string;
  className = "";
  id = "";
  textContent = "";
  type = "";
  tabIndex = 0;
  hidden = false;
  focusVisible = true;
  rect: Rect = { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 };
  readonly classList = new FakeClassList();
  readonly styleProps = new Map<string, string>();
  readonly style = {
    setProperty: (k: string, v: string): void => { this.styleProps.set(k, v); },
    removeProperty: (k: string): void => { this.styleProps.delete(k); },
  };
  readonly listeners: { [type: string]: Array<(e?: unknown) => void> } = {};
  parent: FakeElement | null = null;
  private attrs = new Map<string, string>();
  kids: FakeElement[] = [];
  constructor(tag: string) { this.tagName = tag.toUpperCase(); }
  setAttribute(k: string, v: string): void { this.attrs.set(k, v); }
  getAttribute(k: string): string | null { return this.attrs.get(k) ?? null; }
  removeAttribute(k: string): void { this.attrs.delete(k); }
  appendChild(c: FakeElement): FakeElement { c.parent = this; this.kids.push(c); return c; }
  append(...cs: FakeElement[]): void { for (const c of cs) this.appendChild(c); }
  prepend(c: FakeElement): void { c.parent = this; this.kids.unshift(c); }
  remove(): void {
    if (this.parent === null) return;
    this.parent.kids = this.parent.kids.filter((k) => k !== this);
    this.parent = null;
  }
  querySelector(): null { return null; }
  matches(selector: string): boolean { return selector === ":focus-visible" ? this.focusVisible : false; }
  getBoundingClientRect(): Rect { return this.rect; }
  addEventListener(type: string, fn: (e?: unknown) => void): void {
    (this.listeners[type] ??= []).push(fn);
  }
  removeEventListener(type: string, fn: (e?: unknown) => void): void {
    this.listeners[type] = (this.listeners[type] ?? []).filter((l) => l !== fn);
  }
  dispatch(type: string, event: unknown = { pointerType: "mouse", pointerId: 1 }): void {
    for (const fn of [...(this.listeners[type] ?? [])]) fn(event);
  }
  childAt(i: number): FakeElement {
    const c = this.kids[i];
    if (c === undefined) throw new Error(`no child at ${i}`);
    return c;
  }
}

const documentListeners: { [type: string]: Array<(e?: unknown) => void> } = {};
const fakeDocument = {
  body: new FakeElement("body"),
  documentElement: { clientWidth: 800, clientHeight: 600 },
  createElement: (t: string) => new FakeElement(t),
  createElementNS: (_ns: string, t: string) => new FakeElement(t),
  createComment: (t: string) => new FakeElement(`#comment:${t}`),
  createDocumentFragment: () => new FakeElement("#fragment"),
  addEventListener(type: string, fn: (e?: unknown) => void): void {
    (documentListeners[type] ??= []).push(fn);
  },
  removeEventListener(type: string, fn: (e?: unknown) => void): void {
    documentListeners[type] = (documentListeners[type] ?? []).filter((l) => l !== fn);
  },
};
(globalThis as { document?: unknown }).document = fakeDocument;
(globalThis as { getComputedStyle?: unknown }).getComputedStyle = () => ({ direction: "ltr" });

function dispatchDocument(type: string, event: unknown): void {
  for (const fn of [...(documentListeners[type] ?? [])]) fn(event);
}

function setFinePointer(matches: boolean): void {
  (globalThis as { matchMedia?: unknown }).matchMedia = (query: string) =>
    ({ matches: query === "(hover: hover)" ? matches : false });
}

function mountOne(attrs: { [k: string]: string }): {
  el: FakeElement; body: FakeElement; store: ReactiveStore; ctx: MountCtx;
} {
  fakeDocument.body = new FakeElement("body");
  const store = new ReactiveStore();
  const env = makeRunEnv(store);
  const registry: Registry = { components: {}, globalPool: {}, css: "", schemes: [] };
  const ctx: MountCtx = {
    registry, scheme: "t", owner: "Test", store, runner: new ActionRunner(env), env,
    item: null, disposers: [], slots: null, rowBinding: null,
  };
  const node: XmlNode = { tag: "stack", attrs, children: [], text: "" };
  const parent = new FakeElement("div");
  mountNode(node, ctx, parent as unknown as ParentNode);
  return { el: parent.childAt(0), body: fakeDocument.body, store, ctx };
}

function bubbleOf(body: FakeElement): FakeElement {
  const found = body.kids.find((k) => k.className === "dsx-tooltip");
  if (found === undefined) throw new Error("no tooltip bubble in body");
  return found;
}

// ── the shared corpus, executed verbatim ────────────────────────────────────────────

test("shared tooltip resolve corpus", () => {
  assert.equal(corpus.version, 1);
  assert.ok(corpus.resolve.length > 0, "resolve corpus must not be empty");
  for (const c of corpus.resolve) {
    const got = resolveTooltip(c.tooltip, c.tooltipSide);
    if (c.expect === null) {
      assert.equal(got, null, c.name);
    } else {
      assert.deepEqual(got, { text: c.expect.text, side: c.expect.side }, c.name);
      assert.equal(c.expect.described, true, `${c.name}: a resolved tooltip must describe its element`);
    }
  }
});

test("shared tooltip lifecycle corpus", () => {
  assert.ok(corpus.lifecycle.length > 0, "lifecycle corpus must not be empty");
  for (const c of corpus.lifecycle) {
    const machine = new TooltipLifecycle();
    const actions: TooltipAction[] = [];
    for (const event of c.events) {
      if (event.type === "hoverStart") actions.push(...machine.hoverStart(event.hoverCapable === true));
      else if (event.type === "hoverEnd") actions.push(...machine.hoverEnd());
      else if (event.type === "focus") actions.push(...machine.focus(event.hoverCapable === true));
      else if (event.type === "blur") actions.push(...machine.blur());
      else if (event.type === "escape") actions.push(...machine.escape());
      else actions.push(...machine.unmount());
    }
    assert.deepEqual(actions, c.expect, c.name);
    assert.equal(machine.visible, c.expectVisible, c.name);
  }
});

// ── the renderer wiring ─────────────────────────────────────────────────────────────

test("a mounted tooltip renders a described, hidden bubble — the a11y floor needs no pointer", () => {
  setFinePointer(true);
  const { el, body } = mountOne({ tooltip: "Save the draft" });
  const bubble = bubbleOf(body);
  assert.equal(bubble.getAttribute("role"), "tooltip");
  assert.equal(bubble.textContent, "Save the draft");
  assert.equal(bubble.hidden, true, "hidden until a reveal source shows it");
  assert.ok(bubble.id.length > 0, "the bubble carries a stable id");
  assert.equal(el.getAttribute("aria-describedby"), bubble.id, "describedby identity");
});

test("keyboard focus shows immediately and blur hides", () => {
  setFinePointer(true);
  const { el, body } = mountOne({ tooltip: "Send" });
  const bubble = bubbleOf(body);
  el.dispatch("focus", {});
  assert.equal(bubble.hidden, false, "focus-visible focus reveals with no delay");
  el.dispatch("blur", {});
  assert.equal(bubble.hidden, true, "blur dismisses");
});

test("mouse-click focus (not focus-visible) never reveals", () => {
  setFinePointer(true);
  const { el, body } = mountOne({ tooltip: "Send" });
  el.focusVisible = false;
  el.dispatch("focus", {});
  assert.equal(bubbleOf(body).hidden, true);
});

test("focus on a touch surface (hover: none) never reveals — Article-7 degradation", () => {
  setFinePointer(false);
  const { el, body } = mountOne({ tooltip: "Send" });
  el.dispatch("focus", {});
  assert.equal(bubbleOf(body).hidden, true, "no fine pointer, no visual reveal");
  assert.equal(el.getAttribute("aria-describedby"), bubbleOf(body).id,
    "the description stays — content is never gated behind hover");
});

test("hover intent reveals after the delay and pointer-out dismisses", async () => {
  setFinePointer(true);
  const { el, body } = mountOne({ tooltip: "More options" });
  const bubble = bubbleOf(body);
  el.dispatch("pointerenter", { pointerType: "mouse", pointerId: 1 });
  assert.equal(bubble.hidden, true, "no reveal before the intent delay");
  await delay(TOOLTIP_INTENT_DELAY_MS + 40);
  assert.equal(bubble.hidden, false, "hover intent reveals");
  el.dispatch("pointerleave", { pointerType: "mouse", pointerId: 1 });
  assert.equal(bubble.hidden, true, "pointer-out dismisses");
});

test("a touch pointer never reveals, even after the delay", async () => {
  setFinePointer(true);
  const { el, body } = mountOne({ tooltip: "More options" });
  el.dispatch("pointerenter", { pointerType: "touch", pointerId: 2 });
  await delay(TOOLTIP_INTENT_DELAY_MS + 40);
  assert.equal(bubbleOf(body).hidden, true);
});

test("leaving before the delay cancels the pending intent", async () => {
  setFinePointer(true);
  const { el, body } = mountOne({ tooltip: "More options" });
  el.dispatch("pointerenter", { pointerType: "mouse", pointerId: 1 });
  el.dispatch("pointerleave", { pointerType: "mouse", pointerId: 1 });
  await delay(TOOLTIP_INTENT_DELAY_MS + 40);
  assert.equal(bubbleOf(body).hidden, true);
});

test("escape dismisses and suppresses re-show until the source clears", () => {
  setFinePointer(true);
  const { el, body } = mountOne({ tooltip: "Send" });
  const bubble = bubbleOf(body);
  el.dispatch("focus", {});
  assert.equal(bubble.hidden, false);
  dispatchDocument("keydown", { key: "Escape" });
  assert.equal(bubble.hidden, true, "Escape dismisses");
  el.dispatch("focus", {});
  assert.equal(bubble.hidden, true, "still focused: dismissal holds");
  el.dispatch("blur", {});
  el.dispatch("focus", {});
  assert.equal(bubble.hidden, false, "a fresh focus after the clear shows again");
});

test("the bubble floats on the requested side via the shared solver", () => {
  setFinePointer(true);
  const { el, body } = mountOne({ tooltip: "Above", tooltipSide: "top" });
  const bubble = bubbleOf(body);
  el.rect = { left: 100, right: 140, top: 300, bottom: 330, width: 40, height: 30 };
  bubble.rect = { left: 0, right: 0, top: 0, bottom: 0, width: 80, height: 24 };
  el.dispatch("focus", {});
  assert.equal(bubble.getAttribute("data-dsx-placement"), "top", "tooltipSide names where the bubble is");
  assert.equal(bubble.styleProps.get("top"), `${300 - 24 - 8}px`, "above the element, one gap away");
  const below = mountOne({ tooltip: "Below", tooltipSide: "bottom" });
  const belowBubble = bubbleOf(below.body);
  below.el.rect = { left: 100, right: 140, top: 300, bottom: 330, width: 40, height: 30 };
  below.el.dispatch("focus", {});
  assert.equal(belowBubble.getAttribute("data-dsx-placement"), "bottom");
});

test("tooltip text interpolates; an empty resolution drops description and reveal", async () => {
  setFinePointer(true);
  const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
  const { el, body, store } = mountOne({ tooltip: "{{ tip }}" });
  const bubble = bubbleOf(body);
  assert.equal(el.getAttribute("aria-describedby"), null, "empty text is no tooltip");
  store.set("tip", "Now you see me");
  await settle();
  assert.equal(bubble.textContent, "Now you see me");
  assert.equal(el.getAttribute("aria-describedby"), bubble.id);
  el.dispatch("focus", {});
  assert.equal(bubble.hidden, false);
  store.set("tip", "");
  await settle();
  assert.equal(bubble.hidden, true, "text going empty hides an active show");
  assert.equal(el.getAttribute("aria-describedby"), null);
});

test("elements without tooltip= wire nothing", () => {
  setFinePointer(true);
  const { el, body } = mountOne({});
  assert.equal(body.kids.length, 0, "no bubble in the body");
  assert.equal(el.listeners["pointerenter"], undefined);
  assert.equal(el.listeners["focus"], undefined);
});

test("unmount balances an active show and removes the bubble", () => {
  setFinePointer(true);
  const { el, body, ctx } = mountOne({ tooltip: "Send" });
  const bubble = bubbleOf(body);
  el.dispatch("focus", {});
  assert.equal(bubble.hidden, false);
  for (const dispose of ctx.disposers) dispose();
  assert.equal(bubble.hidden, true, "unmount hides");
  assert.equal(body.kids.includes(bubble), false, "the bubble leaves the document");
});
