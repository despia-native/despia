// Semantic, interaction and weak-cascade gates for DSX web structure controls.

import { test } from "node:test";
import assert from "node:assert/strict";

import type { XmlNode } from "@despia/compiler/xml";
import type { MountCtx } from "../src/mount.ts";
import { ELEMENTS, type ElementApi } from "../src/elements.ts";
import {
  STRUCTURAL_CONTROL_ELEMENTS,
  STRUCTURAL_CHILD_LIMIT,
  STRUCTURAL_CONTROL_TAGS,
  STRUCTURAL_CONTROLS_CSS,
  normalizeStructuralGap,
  normalizeStructuralIndex,
  registerStructuralControls,
} from "../src/structural-controls.ts";

class FakeStyle {
  readonly values = new Map<string, string>();
  setProperty(name: string, value: string): void { this.values.set(name, value); }
  removeProperty(name: string): void { this.values.delete(name); }
}

class FakeEvent {
  key = "";
  defaultPrevented = false;
  preventDefault(): void { this.defaultPrevented = true; }
}

class FakeElement {
  readonly tagName: string;
  className = "";
  textContent = "";
  type = "";
  id = "";
  hidden = false;
  inert = false;
  tabIndex = -1;
  scrollLeft = 0;
  scrollTop = 0;
  clientWidth = 640;
  clientHeight = 480;
  readonly style = new FakeStyle();
  private readonly attrs = new Map<string, string>();
  private readonly childNodes: FakeElement[] = [];
  private readonly listeners = new Map<string, Array<(event: FakeEvent) => void>>();

  constructor(tag: string) { this.tagName = tag.toUpperCase(); }
  setAttribute(name: string, value: string): void { this.attrs.set(name, value); }
  getAttribute(name: string): string | null { return this.attrs.get(name) ?? null; }
  removeAttribute(name: string): void { this.attrs.delete(name); }
  appendChild(child: FakeElement): FakeElement { this.childNodes.push(child); return child; }
  append(...children: FakeElement[]): void { this.childNodes.push(...children); }
  replaceChildren(...children: FakeElement[]): void {
    this.childNodes.splice(0, this.childNodes.length, ...children);
  }
  addEventListener(name: string, listener: (event: FakeEvent) => void): void {
    const listeners = this.listeners.get(name) ?? [];
    listeners.push(listener);
    this.listeners.set(name, listeners);
  }
  dispatch(name: string, key = ""): FakeEvent {
    const event = new FakeEvent();
    event.key = key;
    for (const listener of this.listeners.get(name) ?? []) listener(event);
    return event;
  }
  focus(): void { fakeDocument.activeElement = this; }
  getBoundingClientRect(): DOMRect {
    return { width: this.clientWidth, height: this.clientHeight } as DOMRect;
  }
  querySelectorAll<T>(): T[] { return [] as T[]; }
  childAt(index: number): FakeElement {
    const child = this.childNodes[index];
    if (child === undefined) throw new Error(`missing child ${index}`);
    return child;
  }
  get childCount(): number { return this.childNodes.length; }
}

const fakeDocument = {
  activeElement: null as FakeElement | null,
  createElement: (tag: string) => new FakeElement(tag),
  createElementNS: (_namespace: string, tag: string) => new FakeElement(tag),
};
(globalThis as { document?: unknown }).document = fakeDocument;

type Harness = {
  api: ElementApi;
  writes: Array<[string | undefined, unknown]>;
  events: Array<[string, unknown]>;
};

function harness(values: Record<string, unknown>, defaultChildren: readonly XmlNode[]): Harness {
  const writes: Array<[string | undefined, unknown]> = [];
  const events: Array<[string, unknown]> = [];
  return {
    writes,
    events,
    api: {
      bindText: (expression, apply) => { if (expression !== undefined) apply(expression); },
      bindDisplay: (expression, apply) => { if (expression !== undefined) apply(expression); },
      bindValue: (expression, apply) => { if (expression !== undefined) apply(values[expression]); },
      writeBack: (path, value) => { writes.push([path, value]); values[path ?? ""] = value; },
      handler: (name, payload) => { events.push([name, payload]); },
      hasHandler: () => true,
      children: (parent, nodes = defaultChildren) => {
        for (const _node of nodes) parent.appendChild(document.createElement("span"));
      },
    },
  };
}

function child(tag: string, attrs: Record<string, string> = {}): XmlNode {
  return { tag, attrs, children: [], text: "" };
}

function node(tag: string, attrs: Record<string, string>, children: XmlNode[] = []): XmlNode {
  return { tag, attrs, children, text: "" };
}

const ctx = (): MountCtx => ({ disposers: [] } as unknown as MountCtx);

test("structural controls are explicit, then register canonical tags and tabview alias", () => {
  for (const tag of STRUCTURAL_CONTROL_TAGS) assert.equal(ELEMENTS[tag], undefined, `${tag} starts outside the base floor`);
  registerStructuralControls();
  for (const tag of STRUCTURAL_CONTROL_TAGS) assert.equal(typeof ELEMENTS[tag], "function", tag);
  assert.equal(STRUCTURAL_CONTROL_ELEMENTS["tabview"], STRUCTURAL_CONTROL_ELEMENTS["tabs"]);
});

test("structural number normalization clamps hostile values and real child indices", () => {
  assert.equal(STRUCTURAL_CHILD_LIMIT, 1_000);
  assert.equal(normalizeStructuralIndex(2.9, 4), 2);
  assert.equal(normalizeStructuralIndex(-8, 4), 0);
  assert.equal(normalizeStructuralIndex(Infinity, 4, 3), 3);
  assert.equal(normalizeStructuralIndex(12, 0), 0);
  assert.equal(normalizeStructuralGap(-1, 8), 0);
  assert.equal(normalizeStructuralGap(Infinity, 12), 12);
  assert.equal(normalizeStructuralGap(1_000_000, 8), 16_384);
});

test("static structural allocations stop at the public child budget", () => {
  const children = Array.from({ length: STRUCTURAL_CHILD_LIMIT + 20 }, () => child("text"));
  const h = harness({}, children);
  const previous = console.warn;
  console.warn = () => {};
  try {
    const root = STRUCTURAL_CONTROL_ELEMENTS["list"]!(node("list", {}, children), ctx(), h.api) as unknown as FakeElement;
    assert.equal(root.childCount, STRUCTURAL_CHILD_LIMIT);
  } finally {
    console.warn = previous;
  }
});

test("flow and toolbar preserve native geometry and semantic keyboard grouping", () => {
  const children = [child("button"), child("button")];
  const flowHarness = harness({}, children);
  const flow = STRUCTURAL_CONTROL_ELEMENTS["flow"]!(
    node("flow", { spacing: "6", lineSpacing: "10" }, children), ctx(), flowHarness.api,
  ) as unknown as FakeElement;
  assert.equal(flow.childCount, 2);
  assert.equal(flow.style.values.get("--dsx-flow-spacing"), "6px");
  assert.equal(flow.style.values.get("--dsx-flow-line-spacing"), "10px");

  const toolbarHarness = harness({}, children);
  const bar = STRUCTURAL_CONTROL_ELEMENTS["toolbar"]!(
    node("toolbar", { position: "top" }, children), ctx(), toolbarHarness.api,
  ) as unknown as FakeElement;
  assert.equal(bar.getAttribute("role"), "toolbar");
  assert.equal(bar.getAttribute("aria-orientation"), "horizontal");
  assert.equal(bar.getAttribute("data-dsx-position"), "top");
  assert.equal(bar.getAttribute("aria-label"), "Toolbar");
  assert.equal(bar.style.values.get("--dsx-toolbar-spacing"), undefined, "weak CSS owns the default spacing");

  const named = STRUCTURAL_CONTROL_ELEMENTS["toolbar"]!(
    node("toolbar", { position: "bottom", a11yLabel: "Composer actions" }, children),
    ctx(), harness({}, children).api,
  ) as unknown as FakeElement;
  assert.equal(named.getAttribute("aria-label"), "Composer actions",
    "authored a11yLabel is the accessible name, not the generic Toolbar fallback");
});

test("unbound list and grid emit real collection roles, rows and native defaults", () => {
  const children = [child("text"), child("button")];
  const listHarness = harness({}, children);
  const list = STRUCTURAL_CONTROL_ELEMENTS["list"]!(
    node("list", { axis: "horizontal", scroll: "false" }, children), ctx(), listHarness.api,
  ) as unknown as FakeElement;
  assert.equal(list.getAttribute("role"), "list");
  assert.equal(list.getAttribute("data-dsx-appearance"), "automatic");
  assert.equal(list.getAttribute("data-dsx-axis"), "horizontal");
  assert.equal(list.getAttribute("data-dsx-scroll"), "false");
  assert.equal(list.childAt(0).getAttribute("role"), "listitem");
  assert.equal(list.childAt(0).getAttribute("data-dsx-part"), "row");
  assert.equal(list.childCount, 2);

  const gridHarness = harness({}, children);
  const grid = STRUCTURAL_CONTROL_ELEMENTS["grid"]!(
    node("grid", {}, children), ctx(), gridHarness.api,
  ) as unknown as FakeElement;
  assert.equal(grid.getAttribute("role"), "grid");
  assert.equal(grid.getAttribute("aria-colcount"), "3");
  assert.equal(grid.getAttribute("aria-rowcount"), "1");
  assert.equal(grid.style.values.get("--dsx-grid-columns"), undefined, "weak CSS owns the default columns");
  assert.equal(grid.childAt(0).getAttribute("role"), "row");
  assert.equal(grid.childAt(0).childAt(1).getAttribute("role"), "gridcell");
});

test("unset list align stamps NOTHING (base stretch applies); authored words keep meaning", () => {
  // wave-7 F3: stamping "leading" for unset made every list hug its content — the base
  // .dsx-list rule is align-items: stretch and must win when the author says nothing.
  const children = [child("text")];
  const bare = STRUCTURAL_CONTROL_ELEMENTS["list"]!(
    node("list", {}, children), ctx(), harness({}, children).api,
  ) as unknown as FakeElement;
  assert.equal(bare.getAttribute("data-dsx-align"), null, "no stamp for unset align");

  for (const word of ["leading", "center", "trailing"]) {
    const aligned = STRUCTURAL_CONTROL_ELEMENTS["list"]!(
      node("list", { align: word }, children), ctx(), harness({}, children).api,
    ) as unknown as FakeElement;
    assert.equal(aligned.getAttribute("data-dsx-align"), word, `authored ${word} keeps today's meaning`);
  }
  const garbage = STRUCTURAL_CONTROL_ELEMENTS["list"]!(
    node("list", { align: "sideways" }, children), ctx(), harness({}, children).api,
  ) as unknown as FakeElement;
  assert.equal(garbage.getAttribute("data-dsx-align"), "leading", "unrecognized authored word falls to leading");
});

test("tabs expose the ARIA tab pattern, roving focus and two-way selection", () => {
  const children = [
    child("vstack", { tabTitle: "Home" }),
    child("vstack", { tabTitle: "Inbox", tabBadge: "3" }),
    child("vstack", { tabTitle: "Profile" }),
  ];
  const h = harness({ selected: 0 }, children);
  const root = STRUCTURAL_CONTROL_ELEMENTS["tabs"]!(
    node("tabs", { value: "selected", "on:change": "changed()" }, children), ctx(), h.api,
  ) as unknown as FakeElement;
  const panels = root.childAt(0);
  const tablist = root.childAt(1);
  assert.equal(tablist.getAttribute("role"), "tablist");
  assert.equal(tablist.childAt(0).getAttribute("aria-selected"), "true");
  assert.equal(tablist.childAt(1).tabIndex, -1);
  assert.equal(panels.childAt(0).hidden, false);
  assert.equal(panels.childAt(1).hidden, true);

  tablist.childAt(1).dispatch("click");
  assert.deepEqual(h.writes, [["selected", 1]]);
  assert.deepEqual(h.events, [["change", { value: 1 }]]);
  assert.equal(tablist.childAt(1).getAttribute("aria-selected"), "true");
  assert.equal(panels.childAt(1).inert, false);
  const keyboard = tablist.childAt(1).dispatch("keydown", "ArrowRight");
  assert.equal(keyboard.defaultPrevented, true);
  assert.equal(h.writes.at(-1)?.[1], 2);
  assert.equal(fakeDocument.activeElement, tablist.childAt(2));
});

test("pager and carousel expose swipeable slide semantics, dots and writeback", () => {
  const children = [child("vstack"), child("vstack"), child("vstack")];
  const pagerHarness = harness({ page: 0 }, children);
  const pager = STRUCTURAL_CONTROL_ELEMENTS["pager"]!(
    node("pager", { value: "page", axis: "vertical", dots: "false" }, children), ctx(), pagerHarness.api,
  ) as unknown as FakeElement;
  const pagerViewport = pager.childAt(0);
  const pagerTrack = pagerViewport.childAt(0);
  assert.equal(pager.getAttribute("aria-roledescription"), "carousel");
  assert.equal(pager.getAttribute("data-dsx-axis"), "vertical");
  assert.equal(pagerViewport.getAttribute("dir"), "ltr");
  assert.equal(pager.childAt(1).hidden, true);
  assert.equal(pagerTrack.childAt(0).getAttribute("aria-roledescription"), "slide");
  pagerViewport.dispatch("keydown", "ArrowDown");
  assert.deepEqual(pagerHarness.writes, [["page", 1]]);
  assert.equal(pager.scrollTop, 0, "the viewport, not the section, owns scroll position");
  assert.equal(pagerViewport.scrollTop, 480);

  const carouselHarness = harness({ card: 0 }, children);
  const carousel = STRUCTURAL_CONTROL_ELEMENTS["carousel"]!(
    node("carousel", { value: "card", peek: "24", spacing: "12" }, children), ctx(), carouselHarness.api,
  ) as unknown as FakeElement;
  const carouselDots = carousel.childAt(1);
  carouselDots.childAt(2).dispatch("click");
  assert.deepEqual(carouselHarness.writes, [["card", 2]]);
  assert.equal(carousel.getAttribute("data-dsx-page"), "2");
  assert.equal(carousel.style.values.get("--dsx-carousel-peek"), "24px");
  assert.equal(carouselDots.childAt(2).getAttribute("aria-current"), "true");
});

test("structural presentation stays responsive, token-driven and author-overridable", () => {
  assert.ok(STRUCTURAL_CONTROLS_CSS.startsWith("@layer dsx-elements {"));
  for (const selector of [
    ".dsx-flow", ".dsx-toolbar", ".dsx-list", ".dsx-grid", ".dsx-tabs", ".dsx-paged",
  ]) assert.ok(STRUCTURAL_CONTROLS_CSS.includes(selector), selector);
  assert.ok(STRUCTURAL_CONTROLS_CSS.includes("@media (min-width: 48rem)"));
  assert.ok(STRUCTURAL_CONTROLS_CSS.includes("@media (min-width: 64rem)"));
  assert.ok(STRUCTURAL_CONTROLS_CSS.includes("prefers-reduced-motion"));
  assert.ok(STRUCTURAL_CONTROLS_CSS.includes("forced-colors"));
  assert.ok(STRUCTURAL_CONTROLS_CSS.includes("var(--dsx-toolbar-spacing, 12px)"));
  assert.ok(STRUCTURAL_CONTROLS_CSS.includes("max(16px, env(safe-area-inset-right, 0px))"),
    "toolbar pads the trailing physical edge, not only the leading inset");
  assert.ok(STRUCTURAL_CONTROLS_CSS.includes("max(16px, env(safe-area-inset-left, 0px))"),
    "toolbar still honors the leading notch");
  assert.ok(/\.dsx-toolbar\s*\{[^}]*box-shadow:\s*var\(--dsx-shadow-xs\)/s.test(STRUCTURAL_CONTROLS_CSS),
    "toolbar sits on the xs contact line");
  assert.ok(STRUCTURAL_CONTROLS_CSS.includes("var(--dsx-grid-columns, 3)"));
  assert.ok(STRUCTURAL_CONTROLS_CSS.includes(".dsx-grid-aria-row"));
  assert.ok(STRUCTURAL_CONTROLS_CSS.includes(".dsx-paged:dir(rtl) .dsx-paged-page"));
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(STRUCTURAL_CONTROLS_CSS));
  assert.ok(!/\brgba?\(/.test(STRUCTURAL_CONTROLS_CSS));
  assert.ok(!STRUCTURAL_CONTROLS_CSS.includes("!important"));
});
