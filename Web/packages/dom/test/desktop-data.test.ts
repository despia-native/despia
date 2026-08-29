//
//  desktop-data.test.ts — the desktop face of the data primitives (design-system
//  wave 5). Two gates:
//
//  1. DYNAMIC GRID. `columns="{{ … dsx.screen.width … }}"` is a LIVE binding on
//     both grid paths — the bound reconciler (mount.ts) and the static collection
//     factory (structural-controls.ts). A DSXState screen write re-flows the SAME
//     cell DOM into a new column count; nothing reads columns once at mount. The
//     browser twin (viewport resize → boot.ts seedScreen → this exact mechanism)
//     is exercised by the oracle lane; here the store→binding→layout chain runs
//     against the real ReactiveStore.
//
//  2. TABLE SKIN. The system-quality contract of the weak dsx-table sheet:
//     header type ramp, hover wash behind (hover: hover), inset hairline row
//     separators (the list idiom, logical-aware), space-token cell padding,
//     sticky header, and the frame-owned horizontal overflow driven by the
//     factory's `--dsx-table-columns` count — wide tables scroll INSIDE the
//     frame, never crush their fixed-layout columns, never scroll the page.
//

import { test } from "node:test";
import assert from "node:assert/strict";

import { ReactiveStore, ActionRunner, makeRunEnv, DSXState, flushEffects } from "@despia-native/kernel";
import type { XmlNode } from "@despia-native/compiler/xml";
import type { Registry } from "@despia-native/compiler/resolve";
import { mountNode, type MountCtx } from "../src/mount.ts";
import { registerDataControls, DATA_CONTROLS_CSS } from "../src/data-controls.ts";
import { TOKENS_CSS } from "../src/theme.ts";
import { registerStructuralControls, STRUCTURAL_CONTROLS_CSS } from "../src/structural-controls.ts";

// ── a minimal DOM stand-in (node --test runs this file in its own process) ──────────

class FakeClassList {
  private owner: { className: string };
  constructor(owner: { className: string }) { this.owner = owner; }
  private read(): Set<string> {
    return new Set(this.owner.className.split(/\s+/).filter((c) => c.length > 0));
  }
  private write(s: Set<string>): void { this.owner.className = [...s].join(" "); }
  contains(c: string): boolean { return this.read().has(c); }
  add(...cs: string[]): void { const s = this.read(); for (const c of cs) s.add(c); this.write(s); }
  remove(...cs: string[]): void { const s = this.read(); for (const c of cs) s.delete(c); this.write(s); }
  toggle(c: string, force?: boolean): void {
    const s = this.read();
    const on = force ?? !s.has(c);
    if (on) s.add(c); else s.delete(c);
    this.write(s);
  }
}

class FakeElement {
  tagName: string;
  nodeType = 1;
  className = "";
  textContent = "";
  title = "";
  scope = "";
  hidden = false;
  tabIndex = 0;
  scrollLeft = 0;
  scrollTop = 0;
  clientWidth = 640;
  clientHeight = 480;
  readonly classList = new FakeClassList(this);
  readonly style = {
    values: new Map<string, string>(),
    setProperty(k: string, v: string): void { this.values.set(k, v); },
    removeProperty(k: string): void { this.values.delete(k); },
    getPropertyValue(k: string): string { return this.values.get(k) ?? ""; },
  };
  readonly dataset: { [key: string]: string } = {};
  private attrs = new Map<string, string>();
  private kids: FakeElement[] = [];
  private parent: FakeElement | null = null;
  private listeners = new Map<string, Array<(event: unknown) => void>>();
  constructor(tag: string) { this.tagName = tag.toUpperCase(); }
  setAttribute(k: string, v: string): void { this.attrs.set(k, v); }
  getAttribute(k: string): string | null { return this.attrs.get(k) ?? null; }
  removeAttribute(k: string): void { this.attrs.delete(k); }
  appendChild(c: FakeElement): FakeElement {
    if (c.parent !== null) c.parent.kids = c.parent.kids.filter((child) => child !== c);
    c.parent = this;
    this.kids.push(c);
    return c;
  }
  append(...cs: FakeElement[]): void { for (const c of cs) this.appendChild(c); }
  prepend(c: FakeElement): void {
    if (c.parent !== null) c.parent.kids = c.parent.kids.filter((child) => child !== c);
    c.parent = this;
    this.kids.unshift(c);
  }
  replaceChildren(...cs: FakeElement[]): void {
    for (const child of this.kids) child.parent = null;
    this.kids = [];
    this.append(...cs);
  }
  contains(target: FakeElement): boolean {
    return this === target || this.kids.some((child) => child.contains(target));
  }
  remove(): void {
    if (this.parent !== null) this.parent.kids = this.parent.kids.filter((child) => child !== this);
    this.parent = null;
  }
  querySelector(): null { return null; }
  querySelectorAll<T>(): T[] { return [] as T[]; }
  addEventListener(type: string, listener: (event: unknown) => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }
  focus(): void { fakeDocument.activeElement = this; }
  getBoundingClientRect(): DOMRect {
    return { width: this.clientWidth, height: this.clientHeight } as DOMRect;
  }
  get firstElementChild(): FakeElement | null { return this.kids[0] ?? null; }
  get firstChild(): FakeElement | null { return this.kids[0] ?? null; }
  get lastChild(): FakeElement | null { return this.kids[this.kids.length - 1] ?? null; }
  get nextSibling(): FakeElement | null {
    if (this.parent === null) return null;
    const index = this.parent.kids.indexOf(this);
    return index < 0 ? null : this.parent.kids[index + 1] ?? null;
  }
  childAt(i: number): FakeElement {
    const c = this.kids[i];
    if (c === undefined) throw new Error(`no child at ${i}`);
    return c;
  }
  get childCount(): number { return this.kids.length; }
}

const fakeDocument = {
  baseURI: "https://demo.example/",
  activeElement: null as FakeElement | null,
  createElement: (t: string) => new FakeElement(t),
  createTextNode: (t: string) => {
    const node = new FakeElement("#text");
    node.nodeType = 3;
    node.textContent = t;
    return node;
  },
  createElementNS: (_ns: string, t: string) => new FakeElement(t),
  createComment: (t: string) => new FakeElement(`#comment:${t}`),
  createDocumentFragment: () => new FakeElement("#fragment"),
};
(globalThis as { document?: unknown }).document = fakeDocument;
(globalThis as { window?: unknown }).window = {
  addEventListener: (): void => {},
  removeEventListener: (): void => {},
};

class FakeIntersectionObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): IntersectionObserverEntry[] { return []; }
}
(globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = FakeIntersectionObserver;

registerDataControls();
registerStructuralControls();

// ── the real store behind mountNode, so {{ }} bindings run production makeApi ───────

function mountTree(
  node: XmlNode,
  seed: { [k: string]: unknown } = {},
): { el: FakeElement; store: ReactiveStore } {
  const store = new ReactiveStore();
  for (const [key, value] of Object.entries(seed)) store.set(key, value);
  const env = makeRunEnv(store);
  const registry: Registry = { components: {}, globalPool: {}, css: "", schemes: [] };
  const ctx: MountCtx = {
    registry, scheme: "t", owner: "Test", store, runner: new ActionRunner(env), env,
    item: null, disposers: [], slots: null, rowBinding: null,
  };
  const parent = new FakeElement("div");
  mountNode(node, ctx, parent as unknown as ParentNode);
  return { el: parent.childAt(0), store };
}

function xml(tag: string, attrs: Record<string, string> = {}, children: XmlNode[] = []): XmlNode {
  return { tag, attrs, children, text: "" };
}

function setScreenWidth(width: number): void {
  DSXState.set("screen", { width, height: 900, sizeClass: width >= 768 ? "regular" : "compact" });
  flushEffects();
}

const ADAPTIVE_COLUMNS = "{{ dsx.screen.width >= 1200 ? 4 : dsx.screen.width >= 700 ? 2 : 1 }}";

test("bound <grid> columns follow dsx.screen.width live: same cells, re-flowed groups", () => {
  setScreenWidth(500);
  const { el } = mountTree(
    xml("grid", {
      bind: "cards", key: "id",
      columns: ADAPTIVE_COLUMNS,
      spacing: "{{ dsx.screen.width >= 1200 ? 24 : 12 }}",
    }, [xml("text", { value: "{{ item.id }}" })]),
    { cards: Array.from({ length: 8 }, (_, id) => ({ id })) },
  );

  assert.equal(el.getAttribute("aria-colcount"), "1", "phone width: one column");
  assert.equal(el.getAttribute("aria-rowcount"), "8");
  assert.equal(el.childCount, 8);
  assert.equal(el.style.values.get("--dsx-grid-columns"), "1");
  assert.equal(el.style.values.get("--dsx-collection-spacing"), "12px");
  const cells = Array.from({ length: 8 }, (_, i) => el.childAt(i).childAt(0));

  setScreenWidth(900);
  assert.equal(el.getAttribute("aria-colcount"), "2", "tablet width re-flowed without a remount");
  assert.equal(el.getAttribute("aria-rowcount"), "4");
  assert.equal(el.childCount, 4);
  assert.equal(el.childAt(0).childCount, 2);
  assert.equal(el.childAt(0).childAt(1).getAttribute("aria-colindex"), "2");

  setScreenWidth(1440);
  assert.equal(el.getAttribute("aria-colcount"), "4", "desktop width: four columns");
  assert.equal(el.getAttribute("aria-rowcount"), "2");
  assert.equal(el.childCount, 2);
  assert.equal(el.style.values.get("--dsx-grid-columns"), "4");
  assert.equal(el.style.values.get("--dsx-collection-spacing"), "24px", "spacing rides the same live binding");
  const reflowed = [
    ...Array.from({ length: 4 }, (_, i) => el.childAt(0).childAt(i)),
    ...Array.from({ length: 4 }, (_, i) => el.childAt(1).childAt(i)),
  ];
  cells.forEach((cell, index) => {
    assert.equal(reflowed[index], cell, `cell ${index} was re-flowed, not remounted`);
  });
});

test("static <grid> (no bind) re-chunks its authored children on the same screen binding", () => {
  setScreenWidth(500);
  const { el } = mountTree(
    xml("grid", { columns: ADAPTIVE_COLUMNS }, Array.from({ length: 6 }, () => xml("text", { value: "x" }))),
  );
  assert.equal(el.getAttribute("aria-colcount"), "1");
  assert.equal(el.childCount, 6);

  setScreenWidth(1440);
  assert.equal(el.getAttribute("aria-colcount"), "4");
  assert.equal(el.getAttribute("aria-rowcount"), "2");
  assert.equal(el.childCount, 2);
  assert.equal(el.childAt(0).childCount, 4);
  assert.equal(el.style.values.get("--dsx-grid-columns"), "4");
});

test("grid sheet keeps equal-width overflow-safe columns and the LazyVGrid row analogue", () => {
  assert.match(
    STRUCTURAL_CONTROLS_CSS,
    /\.dsx-grid > \.dsx-grid-aria-row \{[^}]*grid-template-columns: repeat\(var\(--dsx-grid-columns, 3\), minmax\(0, 1fr\)\);/,
    "cells are equal flexible columns that can shrink (cards never overflow)",
  );
  assert.match(STRUCTURAL_CONTROLS_CSS, /\.dsx-grid > \.dsx-grid-aria-row > \.dsx-row \{ min-width: 0; \}/);
  assert.match(
    STRUCTURAL_CONTROLS_CSS,
    /\.dsx-grid > \.dsx-grid-aria-row \{[^}]*content-visibility: auto;[^}]*contain-intrinsic-block-size: auto 240px;/,
    "offscreen grid rows skip render work inside a scrolling viewport",
  );
});

test("<Table> declares its column count so a wide table scrolls inside the frame", () => {
  const rows = [
    { item: "Espresso", qty: 2, total: "$7.00" },
    { item: "Tea", qty: 1, total: "$3.50" },
  ];
  const { el } = mountTree(
    xml("Table", { bind: "rows", columns: "Item,Qty,Total", fields: "item,qty,total" }),
    { rows },
  );
  assert.equal(el.className, "dsx-table-frame");
  assert.equal(el.style.values.get("--dsx-table-columns"), "3");
  // the a11y contract stays: one element per data row, headers with the header trait
  const table = el.childAt(0);
  const head = table.childAt(0);
  const body = table.childAt(1);
  assert.equal(head.childAt(0).childAt(0).scope, "col");
  assert.equal(body.childAt(0).getAttribute("aria-label"), "Espresso, 2, $7.00");
  assert.equal(table.getAttribute("aria-colcount"), "3");

  const { el: fieldsOnly } = mountTree(xml("Table", { bind: "rows", fields: "item,qty" }), { rows });
  assert.equal(fieldsOnly.style.values.get("--dsx-table-columns"), "2", "headerless tables still declare their width floor");
  const { el: empty } = mountTree(xml("Table", {}), {});
  assert.equal(empty.style.values.get("--dsx-table-columns"), "1", "an empty table never collapses to a zero floor");

  assert.match(
    DATA_CONTROLS_CSS,
    /\.dsx-table \{[^}]*min-width: calc\(var\(--dsx-table-columns, 1\) \* 7rem\);/,
    "the sheet turns the declared count into the fixed-layout width floor",
  );
  assert.match(DATA_CONTROLS_CSS, /\.dsx-table-frame \{[^}]*overflow: auto;/, "the frame owns the horizontal scroll, never the page");
});

test("table skin is system-quality: ramp, hover wash, inset separators, sticky header, token padding", () => {
  // header ramp: footnote size, weight 600, secondary ink
  assert.match(
    DATA_CONTROLS_CSS,
    /\.dsx-table th \{[^}]*position: sticky;[^}]*inset-block-start: 0;[^}]*color: var\(--dsx-secondary-label\);[^}]*font-size: var\(--dsx-type-footnote-size\);[^}]*font-weight: var\(--dsx-type-headline-weight\);/,
    "sticky header carries the footnote/semibold/secondary ramp",
  );
  // the weight came off the ramp in the design-system burn-down, so pin the rung's value
  // here too: asserting only the token name would let the ramp move the header silently
  assert.match(TOKENS_CSS, /--dsx-type-headline-weight: 600;/, "and semibold is still 600");
  // row hover wash only where hover is a real capability
  assert.match(
    DATA_CONTROLS_CSS,
    /@media \(hover: hover\) and \(pointer: fine\) \{[\s\S]*?\.dsx-table tbody tr:hover \{ background: color-mix\(in srgb, var\(--dsx-fill\) 55%, transparent\); \}/,
  );
  // inset hairline separators: first cell re-draws its line from the inset with
  // logical offsets (RTL mirrors free); the last row stays clean; forced colors
  // fall back to full-width honest borders
  assert.match(DATA_CONTROLS_CSS, /\.dsx-table tbody td:first-child \{ position: relative; border-block-end-color: transparent; \}/);
  assert.match(
    DATA_CONTROLS_CSS,
    /\.dsx-table tbody td:first-child::after \{[^}]*inset-inline: var\(--dsx-table-inset\) 0;[^}]*height: var\(--dsx-hairline\);[^}]*background: var\(--dsx-separator\);/,
  );
  assert.match(DATA_CONTROLS_CSS, /\.dsx-table tbody tr:last-child td:first-child::after \{ content: none; \}/);
  assert.match(
    DATA_CONTROLS_CSS,
    /@media \(forced-colors: active\) \{[\s\S]*?\.dsx-table tbody td:first-child \{ border-block-end-color: CanvasText; \}[\s\S]*?\.dsx-table tbody td:first-child::after \{ content: none; \}/,
  );
  // comfortable cell padding rides the space tokens through one inset variable,
  // tightened for desktop density alongside the 38px rows
  assert.match(DATA_CONTROLS_CSS, /\.dsx-table-frame \{\n    --dsx-table-inset: var\(--dsx-space-4\);/);
  assert.match(DATA_CONTROLS_CSS, /\.dsx-table th, \.dsx-table td \{[^}]*padding-inline: var\(--dsx-table-inset\);/);
  assert.match(
    DATA_CONTROLS_CSS,
    /@media \(min-width: 64rem\)[\s\S]*?\.dsx-table-frame \{ --dsx-table-inset: var\(--dsx-space-3\); \}/,
  );
  // desktop data rows read in tabular figures
  assert.match(DATA_CONTROLS_CSS, /\.dsx-table td \{[^}]*font-variant-numeric: tabular-nums;/);
  // both schemes stay token-driven: the sheet introduces no literal color
  assert.ok(!/#[0-9a-fA-F]{3}/.test(DATA_CONTROLS_CSS), "no hex literals in the data sheet");
  assert.ok(!/rgba?\(/.test(DATA_CONTROLS_CSS), "no rgb literals in the data sheet");
  assert.ok(!DATA_CONTROLS_CSS.includes("!important"));
});
