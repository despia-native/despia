// The desktop step for <tabs>: at TABS_WIDE_MEDIA the SAME DOM re-places (CSS
// grid) as a leading sidebar rail - the web mirror of iPadOS/macOS adapting tab
// bars into sidebars on regular widths - while everything below the step keeps
// the native-grade edge-to-edge bottom bar (owner ruling 2026-08-19: never a
// floating card). Gates here: the media block and rail geometry, the flat
// premium sidebar surface, aria-orientation wiring off the rendered orientation,
// orientation-keyed arrow keys, and the compact contract (edge-to-edge material
// bar, pane-fill law, pane enter animation).

import { test } from "node:test";
import assert from "node:assert/strict";

import type { XmlNode } from "@despia/compiler/xml";
import type { MountCtx } from "../src/mount.ts";
import type { ElementApi } from "../src/elements.ts";
import {
  STRUCTURAL_CONTROL_ELEMENTS,
  STRUCTURAL_CONTROLS_CSS,
  TABS_WIDE_MEDIA,
} from "../src/structural-controls.ts";

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
  readonly style = { setProperty(): void {}, removeProperty(): void {} };
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
  childAt(index: number): FakeElement {
    const child = this.childNodes[index];
    if (child === undefined) throw new Error(`missing child ${index}`);
    return child;
  }
}

const fakeDocument = {
  activeElement: null as FakeElement | null,
  createElement: (tag: string) => new FakeElement(tag),
  createElementNS: (_namespace: string, tag: string) => new FakeElement(tag),
};
(globalThis as { document?: unknown }).document = fakeDocument;

/** matchMedia twin: one query object with a controllable match state. */
class FakeMediaQuery {
  matches = false;
  readonly queries: string[] = [];
  private readonly listeners: Array<() => void> = [];
  addEventListener(_name: string, listener: () => void): void { this.listeners.push(listener); }
  removeEventListener(_name: string, listener: () => void): void {
    const at = this.listeners.indexOf(listener);
    if (at >= 0) this.listeners.splice(at, 1);
  }
  get listenerCount(): number { return this.listeners.length; }
  set(matches: boolean): void {
    this.matches = matches;
    for (const listener of [...this.listeners]) listener();
  }
}

function installMedia(): FakeMediaQuery {
  const media = new FakeMediaQuery();
  (globalThis as { matchMedia?: unknown }).matchMedia = (query: string) => {
    media.queries.push(query);
    return media;
  };
  return media;
}

function removeMedia(): void {
  delete (globalThis as { matchMedia?: unknown }).matchMedia;
}

type Mounted = {
  tablist: FakeElement;
  writes: Array<[string | undefined, unknown]>;
  ctx: MountCtx;
};

function mountTabs(): Mounted {
  const children: XmlNode[] = [
    { tag: "vstack", attrs: { tabTitle: "Overview", tabIcon: "gearshape" }, children: [], text: "" },
    { tag: "vstack", attrs: { tabTitle: "Reports" }, children: [], text: "" },
    { tag: "vstack", attrs: { tabTitle: "Settings" }, children: [], text: "" },
  ];
  const writes: Array<[string | undefined, unknown]> = [];
  const api = {
    bindText: (expression: string | undefined, apply: (v: string) => void) => {
      if (expression !== undefined) apply(expression);
    },
    bindDisplay: (expression: string | undefined, apply: (v: string) => void) => {
      if (expression !== undefined) apply(expression);
    },
    bindValue: () => {},
    writeBack: (path: string | undefined, value: unknown) => { writes.push([path, value]); },
    handler: () => {},
    hasHandler: () => true,
    children: (parent: HTMLElement) => {
      parent.appendChild(document.createElement("span") as unknown as HTMLElement);
    },
  } as unknown as ElementApi;
  const ctx = { disposers: [] } as unknown as MountCtx;
  const root = STRUCTURAL_CONTROL_ELEMENTS["tabs"]!(
    { tag: "tabs", attrs: { value: "selected" }, children, text: "" }, ctx, api,
  ) as unknown as FakeElement;
  return { tablist: root.childAt(1), writes, ctx };
}

/** Brace-matched body of the first `@media <marker> { ... }` block. */
function mediaBlock(css: string, marker: string): string {
  const from = css.indexOf(marker);
  assert.ok(from >= 0, `missing media block: ${marker}`);
  const open = css.indexOf("{", from);
  let depth = 1;
  let index = open + 1;
  while (index < css.length && depth > 0) {
    if (css[index] === "{") depth += 1;
    else if (css[index] === "}") depth -= 1;
    index += 1;
  }
  return css.slice(open + 1, index - 1);
}

test("the wide step is 69rem: iPad landscape qualifies, iPad portrait keeps the bottom bar", () => {
  assert.equal(TABS_WIDE_MEDIA, "(min-width: 69rem)");
  assert.ok(STRUCTURAL_CONTROLS_CSS.includes(`@media ${TABS_WIDE_MEDIA} {`));
  // 69rem = 1104px at the 16px root: 1366 and 1440+ are in, 1024 is out.
  assert.equal(69 * 16, 1104);
});

test("the sidebar is a grid RE-PLACEMENT of the same DOM: rail geometry + leading rail + full-width panels", () => {
  const wide = mediaBlock(STRUCTURAL_CONTROLS_CSS, `@media ${TABS_WIDE_MEDIA} {`);
  const tabsRule = mediaBlock(wide, ".dsx-tabs");
  assert.ok(tabsRule.includes("--dsx-tabs-rail: 15rem"), "rail width rides a geometry var");
  assert.ok(tabsRule.includes("grid-template-columns: var(--dsx-tabs-rail) minmax(0, 1fr)"),
    "rail column + panels take the remaining width");
  assert.ok(tabsRule.includes("grid-template-rows: minmax(0, 1fr)"), "one full-height row");
  const rail = mediaBlock(wide, ".dsx-tablist");
  assert.ok(rail.includes("grid-column: 1") && rail.includes("grid-row: 1"),
    "the rail leads: grid column 1 is inline-start, so RTL mirrors for free");
  assert.ok(rail.includes("flex-direction: column"), "tab items stack vertically");
  assert.ok(rail.includes("env(safe-area-inset-left)"), "safe-area-inset-left honored");
  const panelsRule = mediaBlock(wide, ".dsx-tab-panels");
  assert.ok(panelsRule.includes("grid-column: 2") && panelsRule.includes("grid-row: 1"),
    "panels fill the remaining width edge to edge");
});

test("the rail is a flat premium surface: secondaryBackground, hairline trailing separator, no glass", () => {
  const wide = mediaBlock(STRUCTURAL_CONTROLS_CSS, `@media ${TABS_WIDE_MEDIA} {`);
  const rail = mediaBlock(wide, ".dsx-tablist");
  assert.ok(rail.includes("background: var(--dsx-secondary-background)"));
  assert.ok(rail.includes("border-inline-end: var(--dsx-hairline) solid var(--dsx-separator)"),
    "trailing separator is a logical property: RTL keeps it on the panel side");
  assert.ok(rail.includes("backdrop-filter: none"), "flat: the compact bar's glass is turned off");
  assert.ok(rail.includes("justify-content: flex-start"),
    "the tablet step's centered clustering never reaches the vertical rail");
  assert.ok(!STRUCTURAL_CONTROLS_CSS.includes(".dsx-tab-icon::before"),
    "no indicator exists at any width: tint carries compact selection, the rail row carries its own");
});

test("the active row is an accent-tinted soft pill and hover stays behind hover:hover", () => {
  const wide = mediaBlock(STRUCTURAL_CONTROLS_CSS, `@media ${TABS_WIDE_MEDIA} {`);
  // AA on the grouped rail: the tint is composed OPAQUELY on the card surface -
  // translucent accent-muted over secondaryBackground drops accent text below 4.5:1.
  const active = mediaBlock(wide, '.dsx-tab[data-dsx-selected="true"] {');
  assert.ok(active.includes("color: var(--dsx-accent)"));
  assert.ok(active.includes("background: color-mix(in srgb, var(--dsx-accent) 10%, var(--dsx-secondary-grouped-background))"));
  const row = mediaBlock(wide, ".dsx-tab {");
  assert.ok(row.includes("border-radius: var(--dsx-radius-control)"), "the row is a pill");
  assert.ok(row.includes("text-align: start"), "icon + label lead the row");
  const hover = mediaBlock(STRUCTURAL_CONTROLS_CSS, `@media ${TABS_WIDE_MEDIA} and (hover: hover) {`);
  assert.ok(hover.includes(".dsx-tab:hover:not(:disabled)"));
  assert.ok(hover.includes('.dsx-tab[data-dsx-selected="true"]:hover:not(:disabled)'),
    "hovering the active row keeps its accent tint");
  // The motion law: no new transitions here - the base .dsx-tab transition
  // (springs on transform only, tokens for durations) carries the active row.
  assert.ok(!wide.includes("transition:") && !wide.includes("animation:"),
    "the sidebar re-placement adds no bespoke motion");
});

test("the compact contract: an edge-to-edge material bar at every sub-rail width, the pane-fill law, the pane enter animation", () => {
  const css = STRUCTURAL_CONTROLS_CSS;
  const base = css.slice(0, css.indexOf("@media"));
  assert.ok(base.includes("border-top: var(--dsx-hairline) solid var(--dsx-separator)"),
    "the bar hairline stays");
  assert.ok(base.includes("backdrop-filter: blur(20px) saturate(1.1)"),
    "the bar keeps its translucent material");
  assert.ok(base.includes("env(safe-area-inset-bottom) max(8px, env(safe-area-inset-left))"),
    "the content band bottom-anchors above the home indicator");
  // Owner ruling 2026-08-19: the >=48rem step keeps the SAME edge-to-edge bar and
  // only clusters the items toward the center - the floating shadow-card dock is
  // retired grammar at every width.
  const tablet = mediaBlock(css, "@media (min-width: 48rem) {");
  assert.ok(tablet.includes("justify-content: center") && tablet.includes("grid-auto-columns: minmax(0, 7.5rem)"),
    "tablet widths cluster the items instead of stretching or floating them");
  assert.ok(!tablet.includes("box-shadow") && !tablet.includes("border-radius") && !tablet.includes("margin"),
    "no floating card at the tablet step");
  assert.ok(!css.includes("@media (min-width: 48rem) and"),
    "the tablet block gains no max-width cap: the wide block overrides instead");
  // pane-fill law + enter animation, still in the un-gated base layer.
  assert.ok(base.includes(".dsx-tab-panel:not([hidden]) { display: flex; flex-direction: column; min-height: 100%; animation: dsx-tab-pane-in var(--dsx-dur-base) var(--dsx-ease-spring-soft); }"));
  assert.ok(css.includes("@keyframes dsx-tab-pane-in { from { opacity: 0; transform: translateY(6px); } }"));
  const wide = mediaBlock(css, `@media ${TABS_WIDE_MEDIA} {`);
  assert.ok(!wide.includes(".dsx-tab-panel:") && !wide.includes(".dsx-tab-panel {"),
    "the wide block re-places .dsx-tab-panels only, never the .dsx-tab-panel rules");
  // The wide block lands after the desktop refinements so equal specificity wins by order.
  assert.ok(css.indexOf(`@media ${TABS_WIDE_MEDIA}`) > css.indexOf("@media (min-width: 64rem)"));
});

test("aria-orientation tracks the rendered orientation and the media listener is disposed", () => {
  const media = installMedia();
  try {
    const { tablist, ctx } = mountTabs();
    assert.deepEqual([...new Set(media.queries)], [TABS_WIDE_MEDIA],
      "the factory watches exactly the skin's wide media");
    assert.equal(tablist.getAttribute("aria-orientation"), "horizontal");
    media.set(true);
    assert.equal(tablist.getAttribute("aria-orientation"), "vertical");
    media.set(false);
    assert.equal(tablist.getAttribute("aria-orientation"), "horizontal");
    assert.equal(media.listenerCount, 1);
    for (const dispose of (ctx as unknown as { disposers: Array<() => void> }).disposers) dispose();
    assert.equal(media.listenerCount, 0, "unmount releases the media listener");
    media.set(true);
    assert.equal(tablist.getAttribute("aria-orientation"), "horizontal", "no writes after dispose");
  } finally {
    removeMedia();
  }
});

test("arrow keys follow the rendered orientation: Up/Down on the sidebar, Left/Right on the dock", () => {
  const media = installMedia();
  try {
    media.matches = true;
    const { tablist, writes } = mountTabs();
    const first = tablist.childAt(0);
    assert.equal(first.dispatch("keydown", "ArrowDown").defaultPrevented, true);
    assert.deepEqual(writes.at(-1), ["selected", 1]);
    assert.equal(fakeDocument.activeElement, tablist.childAt(1));
    assert.equal(tablist.childAt(1).dispatch("keydown", "ArrowUp").defaultPrevented, true);
    assert.deepEqual(writes.at(-1), ["selected", 0]);
    assert.equal(first.dispatch("keydown", "ArrowUp").defaultPrevented, true);
    assert.deepEqual(writes.at(-1), ["selected", 2], "vertical arrows wrap");
    const horizontalKey = tablist.childAt(2).dispatch("keydown", "ArrowRight");
    assert.equal(horizontalKey.defaultPrevented, false, "horizontal arrows are inert on the sidebar");
    assert.equal(tablist.childAt(2).dispatch("keydown", "Home").defaultPrevented, true);
    assert.deepEqual(writes.at(-1), ["selected", 0], "Home/End stay orientation-free");

    media.set(false);
    const back = tablist.childAt(0).dispatch("keydown", "ArrowRight");
    assert.equal(back.defaultPrevented, true, "the dock keeps horizontal arrows");
    assert.deepEqual(writes.at(-1), ["selected", 1]);
    assert.equal(tablist.childAt(1).dispatch("keydown", "ArrowDown").defaultPrevented, false,
      "vertical arrows are inert on the dock");
  } finally {
    removeMedia();
  }
});

test("without matchMedia (SSR shims, the fake-DOM harness) tabs keep the compact contract", () => {
  removeMedia();
  const { tablist, writes } = mountTabs();
  assert.equal(tablist.getAttribute("aria-orientation"), "horizontal");
  assert.equal(tablist.childAt(0).dispatch("keydown", "ArrowRight").defaultPrevented, true);
  assert.deepEqual(writes.at(-1), ["selected", 1]);
  assert.equal(tablist.childAt(0).dispatch("keydown", "ArrowDown").defaultPrevented, false);
});
