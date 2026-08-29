//
//  scroll-dom.test.ts — the `<scroll>` WEB ADAPTER (U01, packages/dom/src/scroll.ts).
//
//  The DECISIONS are judged by the shared corpus on three renderers
//  (OpenSource/Conformance/scroll/ — kernel/test/scroll-conformance.test.ts here). What this
//  file judges is the part the corpus cannot state: the CSS the attribute table becomes, the
//  `--scroll-*` publication onto the real element, the coalescing seen through a real listener,
//  the edge-triggered reachEnd, and the imperative surface resolving through the ONE ref table.
//
//  In-process fake DOM with an injected clock and frame source, so time is driven rather than
//  waited on and the dispatch COUNT is an assertion instead of a hope.
//

import { test } from "node:test";
import assert from "node:assert/strict";

import { RefRegistry } from "@despia/kernel";
import { applyScrollBehaviour, scrollController, type ScrollEnvironment } from "../src/scroll.ts";

// ── the fake element ──────────────────────────────────────────────────────────────

class FakeStyle {
  readonly values: Record<string, string> = {};
  setProperty(name: string, value: string): void { this.values[name] = value; }
  removeProperty(name: string): void { delete this.values[name]; }
}

class FakeElement {
  readonly style = new FakeStyle();
  readonly attributes: Record<string, string> = {};
  readonly children: FakeElement[] = [];
  readonly listeners: Record<string, Array<() => void>> = {};
  scrollLeft = 0;
  scrollTop = 0;
  clientWidth = 390;
  clientHeight = 800;
  scrollWidth = 390;
  scrollHeight = 2000;
  offsetLeft = 0;
  offsetTop = 0;
  offsetWidth = 0;
  offsetHeight = 0;
  scrolledTo: Array<{ left: number; top: number; behavior: string }> = [];
  focused = 0;
  setAttribute(name: string, value: string): void { this.attributes[name] = value; }
  getAttribute(name: string): string | null { return this.attributes[name] ?? null; }
  removeAttribute(name: string): void { delete this.attributes[name]; }
  addEventListener(type: string, run: () => void): void { (this.listeners[type] ??= []).push(run); }
  fire(type: string): void { for (const run of this.listeners[type] ?? []) run(); }
  scrollTo(options: { left: number; top: number; behavior: string }): void {
    this.scrolledTo.push(options);
    this.scrollLeft = options.left;
    this.scrollTop = options.top;
  }
  contains(other: FakeElement): boolean { return this.children.includes(other) || other === this; }
  focus(): void { this.focused += 1; }
}

/** A driven clock: nothing here waits, and the frame source runs inline so one `fire("scroll")`
 *  is exactly one sample — which is what makes the coalescing count assertable. */
function environment(): ScrollEnvironment & { advance(ms: number): void; runTimers(): void } {
  let clock = 0;
  let pending: Array<{ run: () => void; at: number }> = [];
  return {
    now: () => clock,
    requestFrame: (run) => { run(); },
    setTimer: (run, ms) => { const entry = { run, at: clock + ms }; pending.push(entry); return entry; },
    clearTimer: (handle) => { pending = pending.filter((entry) => entry !== handle); },
    advance(ms: number): void { clock += ms; },
    runTimers(): void { const due = pending; pending = []; for (const entry of due) entry.run(); },
  };
}

function hooks(bound: string[] = []) {
  const calls: Array<{ name: string; payload?: Record<string, unknown> }> = [];
  const writes: Array<{ path: string | undefined; value: unknown }> = [];
  return {
    calls,
    writes,
    hasHandler: (name: string): boolean => bound.includes(name),
    handler: (name: string, payload?: Record<string, unknown>): void => { calls.push({ name, payload }); },
    writeBack: (path: string | undefined, value: unknown): void => { writes.push({ path, value }); },
  };
}

function mount(attrs: Record<string, string | undefined>, bound: string[] = []) {
  const element = new FakeElement();
  const env = environment();
  const h = hooks(bound);
  const controller = applyScrollBehaviour(element as unknown as HTMLElement, attrs, h, env);
  return { element, env, h, controller };
}

// ── the attribute table as CSS ────────────────────────────────────────────────────

test("the default tag scrolls vertically and locks the cross axis", () => {
  const { element } = mount({});
  assert.equal(element.style.values["overflow-y"], "auto");
  assert.equal(element.style.values["overflow-x"], "hidden");
  assert.equal(element.getAttribute("data-dsx-scroll-axis"), "vertical");
  assert.equal(element.style.values["scroll-snap-type"], undefined);
  assert.equal(element.style.values["scrollbar-width"], undefined);
});

test("axis=horizontal swaps the two overflow axes", () => {
  const { element } = mount({ axis: "horizontal" });
  assert.equal(element.style.values["overflow-x"], "auto");
  assert.equal(element.style.values["overflow-y"], "hidden");
  assert.equal(element.getAttribute("data-dsx-scroll-axis"), "horizontal");
});

test("paging outranks a declared snap word, exactly as the core folds it", () => {
  const { element, controller } = mount({ paging: "true", snap: "center" });
  assert.equal(controller.config.snap, "page");
  assert.equal(element.style.values["scroll-snap-type"], "y mandatory");
});

test("snap=center is proximity and aligns the children", () => {
  const element = new FakeElement();
  const child = new FakeElement();
  element.children.push(child);
  applyScrollBehaviour(element as unknown as HTMLElement, { snap: "center" }, hooks(), environment());
  assert.equal(element.style.values["scroll-snap-type"], "y proximity");
  assert.equal(child.style.values["scroll-snap-align"], "center");
});

test("indicators, overscroll, bounces and contentInset each write their own CSS", () => {
  const { element } = mount({
    indicators: "false", overscroll: "never", bounces: "false", contentInset: "10 20",
  });
  assert.equal(element.style.values["scrollbar-width"], "none");
  // `bounces=false` is the later write and contains the chain; `overscroll=never` said none.
  assert.equal(element.style.values["overscroll-behavior"], "contain");
  assert.equal(element.style.values["padding"], "10px 20px 10px 20px");
  assert.equal(element.style.values["scroll-padding"], "10px 20px 10px 20px");
});

test("keyboardDismiss has no browser twin, so the divergence is recorded not dropped", () => {
  assert.equal(mount({}).element.getAttribute("data-dsx-keyboard-dismiss"), null);
  assert.equal(mount({ keyboardDismiss: "none" }).element.getAttribute("data-dsx-keyboard-dismiss"), "none");
});

// ── the linked plane ──────────────────────────────────────────────────────────────

test("--scroll-* publishes at rest on the FIRST frame, before any finger", () => {
  const { element } = mount({});
  assert.equal(element.style.values["--scroll-y"], "0");
  assert.equal(element.style.values["--scroll-y-px"], "0px");
  assert.equal(element.style.values["--scroll-progress"], "0");
  assert.equal(element.style.values["--scroll-velocity"], "0");
});

test("a vertical node publishes ONLY its own axis plane, so a nested rail can own the other", () => {
  const { element } = mount({});
  assert.equal(element.style.values["--scroll-x"], undefined);
  const rail = mount({ axis: "horizontal" });
  assert.equal(rail.element.style.values["--scroll-x-px"], "0px");
  assert.equal(rail.element.style.values["--scroll-y"], undefined,
    "the page's --scroll-y must reach the rail's children by CSS inheritance, not by a rewrite");
});

test("--scroll-progress tracks the offset across the scrollable range", () => {
  const { element } = mount({});
  element.scrollTop = 600;      // maxY = 2000 - 800 = 1200
  element.fire("scroll");
  assert.equal(element.style.values["--scroll-y"], "600");
  assert.equal(element.style.values["--scroll-progress"], "0.5");
});

test("the style plane publishes even with no handler bound — that is the whole split", () => {
  const { element, h } = mount({});
  element.scrollTop = 300;
  element.fire("scroll");
  assert.equal(element.style.values["--scroll-y"], "300");
  assert.equal(h.calls.length, 0, "no handler bound means no bus traffic");
});

// ── observation ───────────────────────────────────────────────────────────────────

test("on:scroll is coalesced to one dispatch per frame budget", () => {
  const { element, env, h } = mount({}, ["scroll"]);
  h.calls.length = 0;
  // 40 samples 4 ms apart = 160 ms of scrolling. At a 16 ms budget that is at most 11 dispatches.
  for (let i = 0; i < 40; i += 1) {
    element.scrollTop = i * 10;
    env.advance(4);
    element.fire("scroll");
  }
  assert.ok(h.calls.length > 0, "a bound handler must see the scroll");
  assert.ok(h.calls.length <= 11, `coalescing bound exceeded: ${h.calls.length}`);
});

test("the on:scroll payload carries the whole documented shape", () => {
  const { element, env, h } = mount({}, ["scroll"]);
  h.calls.length = 0;
  element.scrollTop = 120;
  env.advance(50);
  element.fire("scroll");
  const payload = h.calls[0]?.payload ?? {};
  assert.deepEqual(Object.keys(payload).sort(), [
    "atBottom", "atTop", "contentHeight", "contentWidth", "direction",
    "dx", "dy", "height", "velocity", "width", "x", "y",
  ]);
  assert.equal(payload["y"], 120);
  assert.equal(payload["direction"], "down");
});

test("on:reachEnd is EDGE-triggered: once at the rail, again only after leaving", () => {
  const { element, env, h } = mount({ threshold: "0" }, ["reachEnd"]);
  const reaches = (): number => h.calls.filter((c) => c.name === "reachEnd").length;
  element.scrollTop = 1200;
  env.advance(20);
  element.fire("scroll");
  assert.equal(reaches(), 1);
  for (let i = 0; i < 5; i += 1) { env.advance(20); element.fire("scroll"); }
  assert.equal(reaches(), 1, "sitting at the bottom must not re-fire");
  element.scrollTop = 200;
  env.advance(20);
  element.fire("scroll");
  element.scrollTop = 1200;
  env.advance(20);
  element.fire("scroll");
  assert.equal(reaches(), 2, "the latch releases when the user scrolls back out");
});

test("on:scrollEnd fires on settle, because the web has no deceleration callback", () => {
  const { element, env, h } = mount({}, ["scrollEnd"]);
  element.scrollTop = 400;
  env.advance(20);
  element.fire("scroll");
  assert.equal(h.calls.length, 0, "not while it is still moving");
  env.runTimers();
  assert.equal(h.calls.filter((c) => c.name === "scrollEnd").length, 1);
});

test("bind writes the offset pair back through the renderer", () => {
  const { element, env, h } = mount({ bind: "feed.offset" });
  h.writes.length = 0;
  element.scrollTop = 250;
  env.advance(20);
  element.fire("scroll");
  assert.deepEqual(h.writes.at(-1), { path: "feed.offset", value: { x: 0, y: 250 } });
});

// ── the imperative surface ────────────────────────────────────────────────────────

test("to/toTop/toBottom clamp into the range and never over-scroll", () => {
  const { element, controller } = mount({});
  controller.to({ y: 99999 });
  assert.deepEqual(element.scrolledTo.at(-1), { left: 0, top: 1200, behavior: "smooth" });
  controller.toTop(false);
  assert.deepEqual(element.scrolledTo.at(-1), { left: 0, top: 0, behavior: "auto" });
  controller.toBottom();
  assert.deepEqual(element.scrolledTo.at(-1), { left: 0, top: 1200, behavior: "smooth" });
});

test("toElement resolves through the ONE ref table and honours each alignment", () => {
  const registry = new RefRegistry<unknown>();
  (globalThis as unknown as Record<symbol, unknown>)[Symbol.for("dsx.refs.v1")] = registry;

  const element = new FakeElement();
  const row = new FakeElement();
  row.offsetTop = 1500;
  row.offsetHeight = 100;
  element.children.push(row);
  const controller = applyScrollBehaviour(element as unknown as HTMLElement, {}, hooks(), environment());
  registry.provide("row47", row);
  registry.provide("feed", element);

  assert.equal(controller.toElement({ ref: "row47", align: "start", animated: false }), true);
  assert.deepEqual(element.scrolledTo.at(-1), { left: 0, top: 1200, behavior: "auto" },
    "clamped to maxY — an imperative call never leaves a band of nothing");

  // `dsx.scroll("feed")` finds the controller through the element the ref published.
  assert.equal(scrollController("feed"), controller);
  assert.equal(scrollController("nope"), null);
});

test("toElement on an unrealised row is a no-op, not a scroll to a guessed offset", () => {
  const registry = new RefRegistry<unknown>();
  (globalThis as unknown as Record<symbol, unknown>)[Symbol.for("dsx.refs.v1")] = registry;
  const { element, controller } = mount({});
  assert.equal(controller.toElement({ ref: "not-mounted" }), false);
  assert.equal(element.scrolledTo.length, 0);
});

test("toElement moves accessibility focus ONLY when the caller asks", () => {
  const registry = new RefRegistry<unknown>();
  (globalThis as unknown as Record<symbol, unknown>)[Symbol.for("dsx.refs.v1")] = registry;
  const element = new FakeElement();
  const row = new FakeElement();
  row.offsetTop = 200;
  row.offsetHeight = 100;
  element.children.push(row);
  const controller = applyScrollBehaviour(element as unknown as HTMLElement, {}, hooks(), environment());
  registry.provide("row", row);
  controller.toElement({ ref: "row", align: "start" });
  assert.equal(row.focused, 0, "a scroll is not a focus change");
  controller.toElement({ ref: "row", align: "start", focus: true });
  assert.equal(row.focused, 1);
});

// ── maintainPosition ──────────────────────────────────────────────────────────────

test("maintainPosition compensates a PREPEND and leaves an append alone", () => {
  const { element, controller } = mount({ maintainPosition: "true" });
  const anchor = new FakeElement();
  anchor.offsetTop = 500;
  element.scrollTop = 500;

  controller.captureAnchor(anchor as unknown as HTMLElement);
  anchor.offsetTop = 900;                 // 20 rows landed above it
  element.scrollHeight = 2400;
  controller.restoreAnchor(anchor as unknown as HTMLElement);
  assert.equal(element.scrollTop, 900, "the anchor stays under the same pixel");

  element.scrolledTo.length = 0;
  controller.captureAnchor(anchor as unknown as HTMLElement);
  element.scrollHeight = 2800;            // an APPEND moves nothing above the anchor
  controller.restoreAnchor(anchor as unknown as HTMLElement);
  assert.equal(element.scrolledTo.length, 0, "an append compensates by zero, so nothing moves");
});

test("maintainPosition=false is inert even with anchors captured", () => {
  const { element, controller } = mount({});
  const anchor = new FakeElement();
  anchor.offsetTop = 100;
  controller.captureAnchor(anchor as unknown as HTMLElement);
  anchor.offsetTop = 400;
  controller.restoreAnchor(anchor as unknown as HTMLElement);
  assert.equal(element.scrolledTo.length, 0);
});
