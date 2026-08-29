// <split> - the shared planning corpus (OpenSource/Conformance/split/split.json, the
// Kotlin SplitPlan / Swift SplitPlan twins run the same file), planner invariants, the
// DOM factory's stack/columns/overlay behavior, and the @despia/server SSR twin.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

import type { XmlNode } from "@despia/compiler/xml";
import { compileComponent } from "@despia/compiler/component";
import type { Registry } from "@despia/compiler/resolve";
import type { MountCtx } from "../src/mount.ts";
import type { ElementApi } from "../src/elements.ts";
import {
  STRUCTURAL_CONTROL_ELEMENTS, STRUCTURAL_CONTROL_TAGS, STRUCTURAL_CONTROLS_CSS,
} from "../src/structural-controls.ts";
import {
  SPLIT_CSS, SPLIT_ROLE_ORDER, resolveSplit, resolveSplitRoles, splitSelectionActive,
  type SplitPlan, type SplitRole,
} from "../src/split.ts";
import { renderToString } from "../../server/src/render.ts";

const here = dirname(fileURLToPath(import.meta.url));
const corpus = JSON.parse(
  readFileSync(join(here, "../../../../Conformance/split/split.json"), "utf8"),
) as {
  cases: Array<{
    name: string;
    attrs: Record<string, string>;
    childRoles: Array<string | null>;
    width: number | "nonfinite";
    expect: Partial<SplitPlan> & { sidebar?: { min: number; ideal: number; max: number } };
  }>;
  selection: Array<{ name: string; value: unknown; active: boolean }>;
};

// ── the corpus (all three runners execute this file) ──────────────────────────────

test("shared split planning corpus", () => {
  assert.equal(corpus.cases.length, 29);
  for (const c of corpus.cases) {
    const width = c.width === "nonfinite" ? Number.NaN : c.width;
    const plan = resolveSplit(c.attrs, c.childRoles, width);
    for (const [key, expected] of Object.entries(c.expect)) {
      assert.deepEqual(plan[key as keyof SplitPlan], expected, `${c.name}: ${key}`);
    }
  }
});

test("shared split selection corpus", () => {
  assert.equal(corpus.selection.length, 7);
  for (const c of corpus.selection) {
    assert.equal(splitSelectionActive(c.value), c.active, c.name);
  }
});

test("hostile and boundary plans preserve planner invariants", () => {
  const words = [null, "sidebar", "content", "detail", " DETAIL ", "primary", ""];
  const numbers = ["-5", "0", "319", "320", "760", "1104", "4096", "99999", "NaN", "", "not-a-number", " 500 "];
  let seed = 0x53504c49;
  const random = (bound: number): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % bound;
  };
  for (let run = 0; run < 20_000; run += 1) {
    const childRoles = Array.from({ length: random(5) }, () => words[random(words.length)] ?? null);
    const attrs: Record<string, string> = {
      collapseAt: numbers[random(numbers.length)]!,
      expandAt: numbers[random(numbers.length)]!,
      resizable: ["true", "false", " FALSE ", ""][random(4)]!,
      sidebarMin: numbers[random(numbers.length)]!,
      sidebarIdeal: numbers[random(numbers.length)]!,
      contentMax: numbers[random(numbers.length)]!,
      detailMin: numbers[random(numbers.length)]!,
    };
    const width = [Number.NaN, Number.POSITIVE_INFINITY, -100, 0, 389, 760, 1103, 1104, 2000][random(9)]!;
    const plan = resolveSplit(attrs, childRoles, width);

    assert.equal(plan.panes, Math.min(childRoles.length, 3));
    assert.equal(plan.roles.length, plan.panes);
    assert.equal(new Set(plan.roles).size, plan.roles.length, "roles are unique");
    assert.ok(plan.collapseAt >= 320 && plan.collapseAt <= 4096);
    assert.ok(plan.expandAt >= plan.collapseAt && plan.expandAt <= 4096);
    assert.ok(plan.sidebar.min >= 120 && plan.sidebar.min <= 1024);
    assert.ok(plan.sidebar.ideal >= plan.sidebar.min && plan.sidebar.ideal <= 1600);
    assert.ok(plan.sidebar.max >= plan.sidebar.ideal && plan.sidebar.max <= 1600);
    assert.ok(plan.content.max >= plan.content.ideal && plan.content.ideal >= plan.content.min);
    assert.ok(plan.detailMin >= 120 && plan.detailMin <= 1024);
    if (plan.presentation === "stack") assert.deepEqual(plan.columns, []);
    else assert.deepEqual(plan.columns, SPLIT_ROLE_ORDER.filter((role) => plan.columns.includes(role)), "canonical order");
    for (const role of plan.columns) assert.ok(plan.roles.includes(role));
    if (plan.resizable) assert.ok(plan.presentation === "columns" && plan.columns.length >= 2);
    if (plan.overlay) assert.ok(plan.roles.includes("sidebar"));
    if (plan.panes > 0) assert.ok(plan.roles.includes(plan.host));
  }
});

test("role resolution is total and first-claimant stable", () => {
  assert.deepEqual(resolveSplitRoles([]), []);
  assert.deepEqual(resolveSplitRoles([null, null]), ["sidebar", "detail"]);
  assert.deepEqual(resolveSplitRoles(["detail", "detail", "detail"]), ["detail", "sidebar", "content"]);
  assert.deepEqual(resolveSplitRoles([undefined, "content", undefined]), ["sidebar", "content", "detail"]);
});

// ── the factory (fake DOM, the structural-controls harness pattern) ───────────────

class FakeStyle {
  readonly values = new Map<string, string>();
  setProperty(name: string, value: string): void { this.values.set(name, value); }
  removeProperty(name: string): void { this.values.delete(name); }
}

class FakeEvent {
  key = "";
  clientX = 0;
  defaultPrevented = false;
  preventDefault(): void { this.defaultPrevented = true; }
  stopPropagation(): void {}
}

class FakeElement {
  readonly tagName: string;
  className = "";
  textContent = "";
  type = "";
  hidden = false;
  inert = false;
  tabIndex = -1;
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
  insertBefore(child: FakeElement, before: FakeElement): FakeElement {
    const index = this.childNodes.indexOf(before);
    this.childNodes.splice(index < 0 ? this.childNodes.length : index, 0, child);
    return child;
  }
  replaceChildren(...children: FakeElement[]): void {
    this.childNodes.splice(0, this.childNodes.length, ...children);
  }
  addEventListener(name: string, listener: (event: FakeEvent) => void): void {
    const listeners = this.listeners.get(name) ?? [];
    listeners.push(listener);
    this.listeners.set(name, listeners);
  }
  removeEventListener(): void {}
  dispatch(name: string, mutate: (event: FakeEvent) => void = () => {}): FakeEvent {
    const event = new FakeEvent();
    mutate(event);
    for (const listener of this.listeners.get(name) ?? []) listener(event);
    return event;
  }
  focus(): void { fakeDocument.activeElement = this; }
  find(predicate: (e: FakeElement) => boolean): FakeElement | null {
    for (const child of this.childNodes) {
      if (predicate(child)) return child;
      const nested = child.find(predicate);
      if (nested !== null) return nested;
    }
    return null;
  }
  byClass(cls: string): FakeElement {
    const found = this.find((e) => e.className.split(" ").includes(cls));
    if (found === null) throw new Error(`missing .${cls}`);
    return found;
  }
  all(predicate: (e: FakeElement) => boolean, into: FakeElement[] = []): FakeElement[] {
    for (const child of this.childNodes) {
      if (predicate(child)) into.push(child);
      child.all(predicate, into);
    }
    return into;
  }
  get childCount(): number { return this.childNodes.length; }
}

const fakeDocument = {
  activeElement: null as FakeElement | null,
  createElement: (tag: string) => new FakeElement(tag),
  createElementNS: (_namespace: string, tag: string) => new FakeElement(tag),
  addEventListener: () => {},
  removeEventListener: () => {},
};
(globalThis as { document?: unknown }).document = fakeDocument;

let resizeCallback: ((entries: Array<{ contentRect: { width: number } }>) => void) | null = null;
class FakeResizeObserver {
  constructor(callback: (entries: Array<{ contentRect: { width: number } }>) => void) {
    resizeCallback = callback;
  }
  observe(): void {}
  disconnect(): void {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver = FakeResizeObserver;

type Harness = {
  api: ElementApi;
  writes: Array<[string | undefined, unknown]>;
  events: Array<[string, unknown]>;
};

function harness(values: Record<string, unknown>): Harness {
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
      children: (parent, nodes = []) => {
        for (const _node of nodes) parent.appendChild(document.createElement("span") as unknown as HTMLElement);
      },
    },
  };
}

function child(attrs: Record<string, string> = {}): XmlNode {
  return { tag: "vstack", attrs, children: [], text: "" };
}

function splitNode(attrs: Record<string, string>, children: XmlNode[]): XmlNode {
  return { tag: "split", attrs, children, text: "" };
}

const ctx = (): MountCtx => ({ disposers: [] } as unknown as MountCtx);
const factory = STRUCTURAL_CONTROL_ELEMENTS["split"]!;
const resize = (width: number): void => { resizeCallback?.([{ contentRect: { width } }]); };
const panes = (root: FakeElement): FakeElement[] =>
  root.all((e) => e.getAttribute("data-dsx-pane") !== null);

test("split registers with the structural family and its sheet stays weak-layered", () => {
  assert.ok(STRUCTURAL_CONTROL_TAGS.has("split"));
  assert.equal(typeof STRUCTURAL_CONTROL_ELEMENTS["split"], "function");
  assert.ok(SPLIT_CSS.startsWith("@layer dsx-elements {"));
  assert.ok(!SPLIT_CSS.includes("!important"));
  assert.ok(STRUCTURAL_CONTROLS_CSS.includes(".dsx-split"), "the family sheet carries the split rules");
  assert.match(SPLIT_CSS, /--dsx-ease-spring-soft/, "push and overlay ride the system spring");
  assert.match(SPLIT_CSS, /prefers-reduced-motion/, "reduced motion collapses the push");
  assert.match(SPLIT_CSS, /forced-colors: active/);
});

test("a two-pane split mounts canonical panes and stacks at width zero", () => {
  const h = harness({});
  const root = factory(splitNode({}, [child(), child()]), ctx(), h.api) as unknown as FakeElement;
  assert.equal(root.getAttribute("role"), "group");
  assert.equal(root.getAttribute("aria-label"), "Split view");
  assert.equal(root.getAttribute("data-dsx-presentation"), "stack");
  assert.equal(root.getAttribute("data-dsx-panes"), "2");
  assert.equal(root.getAttribute("data-dsx-detail-active"), "false");
  assert.equal(root.style.values.get("--dsx-split-columns"), "minmax(0, 1fr)");
  const mounted = panes(root);
  assert.deepEqual(mounted.map((p) => p.getAttribute("data-dsx-pane")), ["sidebar", "detail"]);
  assert.equal(mounted[0]!.getAttribute("data-dsx-visible"), "true", "the sidebar hosts the stack");
  assert.equal(mounted[1]!.getAttribute("data-dsx-visible"), "false");
  assert.equal(mounted[1]!.inert, true);
  assert.equal(mounted[1]!.getAttribute("aria-hidden"), "true");
});

test("desktop width pins columns, sizes the grid and arms the divider", () => {
  const h = harness({});
  const root = factory(splitNode({}, [child(), child()]), ctx(), h.api) as unknown as FakeElement;
  resize(1680);
  assert.equal(root.getAttribute("data-dsx-presentation"), "columns");
  assert.equal(root.getAttribute("data-dsx-columns"), "sidebar detail");
  assert.equal(root.getAttribute("data-dsx-resizable"), "true");
  assert.equal(root.style.values.get("--dsx-split-columns"), "280px auto minmax(min(360px, 100%), 1fr)");
  const divider = root.byClass("dsx-split-divider");
  assert.equal(divider.hidden, false);
  assert.equal(divider.getAttribute("role"), "separator");
  assert.equal(divider.getAttribute("aria-orientation"), "vertical");
  assert.equal(divider.getAttribute("aria-valuemin"), "220");
  assert.equal(divider.getAttribute("aria-valuemax"), "360");
  assert.equal(divider.getAttribute("aria-valuenow"), "280");
  assert.equal(divider.tabIndex, 0);
  for (const pane of panes(root)) assert.equal(pane.getAttribute("data-dsx-visible"), "true");
});

test("divider keyboard resize follows the window-splitter contract and clamps", () => {
  const h = harness({});
  const root = factory(splitNode({}, [child(), child()]), ctx(), h.api) as unknown as FakeElement;
  resize(1680);
  const divider = root.byClass("dsx-split-divider");
  divider.dispatch("keydown", (e) => { e.key = "ArrowRight"; });
  assert.equal(divider.getAttribute("aria-valuenow"), "296");
  assert.equal(root.style.values.get("--dsx-split-columns"), "296px auto minmax(min(360px, 100%), 1fr)");
  divider.dispatch("keydown", (e) => { e.key = "End"; });
  assert.equal(divider.getAttribute("aria-valuenow"), "360");
  divider.dispatch("keydown", (e) => { e.key = "Home"; });
  assert.equal(divider.getAttribute("aria-valuenow"), "220");
  divider.dispatch("keydown", (e) => { e.key = "ArrowLeft"; });
  assert.equal(divider.getAttribute("aria-valuenow"), "220", "clamped at the pane minimum");
});

test("resizable false disarms the divider without unpinning columns", () => {
  const h = harness({});
  const root = factory(splitNode({ resizable: "false" }, [child(), child()]), ctx(), h.api) as unknown as FakeElement;
  resize(1680);
  assert.equal(root.getAttribute("data-dsx-columns"), "sidebar detail");
  assert.equal(root.getAttribute("data-dsx-resizable"), "false");
  const divider = root.byClass("dsx-split-divider");
  assert.equal(divider.tabIndex, -1);
  divider.dispatch("keydown", (e) => { e.key = "ArrowRight"; });
  assert.equal(divider.getAttribute("aria-valuenow"), "280", "keyboard resize is inert");
});

test("selection routing pushes the detail on phone and the back pop clears it", () => {
  const h = harness({ selected: "note-7" });
  const root = factory(
    splitNode({ value: "selected" }, [child(), child()]), ctx(), h.api,
  ) as unknown as FakeElement;
  assert.equal(root.getAttribute("data-dsx-detail-active"), "true");
  const detail = panes(root)[1]!;
  assert.equal(detail.getAttribute("data-dsx-visible"), "true");
  const back = root.byClass("dsx-split-back");
  assert.equal(back.hidden, false);
  back.dispatch("click");
  assert.equal(root.getAttribute("data-dsx-detail-active"), "false");
  assert.equal(detail.getAttribute("data-dsx-visible"), "false");
  assert.deepEqual(h.writes, [["selected", ""]]);
  assert.deepEqual(h.events, [["change", { value: "" }]]);
});

test("a pushed detail yields the sidebar toggle to the back pop", () => {
  const h = harness({ selected: "note-2" });
  const root = factory(
    splitNode({ value: "selected" }, [child(), child(), child()]), ctx(), h.api,
  ) as unknown as FakeElement;
  // width 0 = stack, content hosts, detail pushed: the floating toggle must not
  // intercept the Back button it would otherwise cover (both sit top-leading).
  assert.equal(root.getAttribute("data-dsx-detail-active"), "true");
  const toggle = root.byClass("dsx-split-toggle");
  assert.equal(toggle.hidden, true);
  root.byClass("dsx-split-back").dispatch("click");
  assert.equal(root.getAttribute("data-dsx-detail-active"), "false");
  assert.equal(toggle.hidden, false, "the toggle returns with the host");
  assert.equal(panes(root)[1]!.getAttribute("data-dsx-chrome"), "true",
    "the host reserves the toggle's chrome strip");
});

test("a three-pane split overlays its sidebar below the expand step", () => {
  const h = harness({});
  const root = factory(splitNode({}, [child(), child(), child()]), ctx(), h.api) as unknown as FakeElement;
  resize(1024);
  assert.equal(root.getAttribute("data-dsx-presentation"), "columns");
  assert.equal(root.getAttribute("data-dsx-columns"), "content detail");
  assert.equal(root.getAttribute("data-dsx-overlay"), "true");
  assert.equal(root.getAttribute("data-dsx-overlay-open"), "false");
  const toggle = root.byClass("dsx-split-toggle");
  assert.equal(toggle.hidden, false);
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  const sidebar = panes(root)[0]!;
  assert.equal(sidebar.getAttribute("data-dsx-visible"), "false");
  assert.equal(panes(root)[1]!.getAttribute("data-dsx-chrome"), "true",
    "the first pinned column reserves the toggle's chrome strip");

  toggle.dispatch("click");
  assert.equal(root.getAttribute("data-dsx-overlay-open"), "true");
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  assert.equal(sidebar.getAttribute("data-dsx-visible"), "true");
  assert.equal(sidebar.getAttribute("data-dsx-chrome"), "true", "the open overlay owns the strip");
  assert.equal(panes(root)[1]!.getAttribute("data-dsx-chrome"), null);
  assert.equal(root.byClass("dsx-split-scrim").hidden, false);

  root.dispatch("keydown", (e) => { e.key = "Escape"; });
  assert.equal(root.getAttribute("data-dsx-overlay-open"), "false");
  assert.equal(sidebar.getAttribute("data-dsx-visible"), "false");
  assert.equal(root.byClass("dsx-split-scrim").hidden, true);

  resize(1680);
  assert.equal(root.getAttribute("data-dsx-columns"), "sidebar content detail");
  assert.equal(root.getAttribute("data-dsx-overlay"), "false");
  assert.equal(toggle.hidden, true);
  assert.equal(sidebar.getAttribute("data-dsx-visible"), "true");
  for (const pane of panes(root)) {
    assert.equal(pane.getAttribute("data-dsx-chrome"), null, "no strip once the toggle hides");
  }
});

test("explicit paneRole routes children and authored breakpoints move the steps", () => {
  const h = harness({});
  const root = factory(
    splitNode({ collapseAt: "500", expandAt: "900" }, [
      child({ paneRole: "detail" }), child({ paneRole: "sidebar" }), child(),
    ]), ctx(), h.api,
  ) as unknown as FakeElement;
  assert.deepEqual(panes(root).map((p) => p.getAttribute("data-dsx-pane")), ["sidebar", "content", "detail"]);
  resize(920);
  assert.equal(root.getAttribute("data-dsx-columns"), "sidebar content detail");
  resize(600);
  assert.equal(root.getAttribute("data-dsx-columns"), "content detail");
  resize(480);
  assert.equal(root.getAttribute("data-dsx-presentation"), "stack");
});

// ── the @despia/server twin (attr-for-attr with the width-zero client mount) ──────

test("SSR renders the same width-zero split the client mounts", () => {
  const screen = (name: string, selected: string): [string, ReturnType<typeof compileComponent>] => [
    `t.${name}`,
    compileComponent(name, "t", `<split value="selected">
      <head><variable as="selected">return ${JSON.stringify(selected)}</variable></head>
      <vstack paneRole="sidebar"><text value="List"/></vstack>
      <vstack paneRole="detail"><text value="Detail"/></vstack>
    </split>`),
  ];
  const registry: Registry = {
    components: Object.fromEntries([screen("Screen", "note-1"), screen("Empty", "")]),
    globalPool: {}, css: "", schemes: [],
  };
  const html = renderToString(registry, "t.Screen");
  assert.match(html, /class="dsx-split"/);
  assert.match(html, /role="group"/);
  assert.match(html, /aria-label="Split view"/);
  assert.match(html, /data-dsx-presentation="stack"/);
  assert.match(html, /data-dsx-panes="2"/);
  assert.match(html, /data-dsx-detail-active="true"/);
  assert.match(html, /--dsx-split-columns: minmax\(0, 1fr\)/);
  assert.match(html, /class="dsx-split-scrim" aria-hidden="true" hidden/);
  assert.match(html, /data-dsx-pane="sidebar"/);
  assert.match(html, /data-dsx-pane="detail"/);
  assert.match(html, /class="dsx-split-back"/);
  assert.match(html, /class="dsx-split-divider" role="separator" aria-orientation="vertical"[^>]*hidden/);
  const empty = renderToString(registry, "t.Empty");
  assert.match(empty, /data-dsx-detail-active="false"/);
  assert.match(empty, /data-dsx-pane="detail"[^>]* inert aria-hidden="true"/);
});

test("SSR three-pane split carries the overlay toggle and canonical pane order", () => {
  const component = compileComponent("Wide", "t", `<split>
    <vstack paneRole="detail"><text value="D"/></vstack>
    <vstack paneRole="sidebar"><text value="S"/></vstack>
    <vstack><text value="C"/></vstack>
  </split>`);
  const registry: Registry = { components: { "t.Wide": component }, globalPool: {}, css: "", schemes: [] };
  const html = renderToString(registry, "t.Wide");
  assert.match(html, /data-dsx-overlay="true"/);
  assert.match(html, /class="dsx-split-toggle"/);
  assert.match(html, /data-dsx-pane="content"[^>]*data-dsx-chrome="true"/);
  const order = [...html.matchAll(/data-dsx-pane="(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual(order, ["sidebar", "content", "detail"]);
  const roles: SplitRole[] = ["sidebar", "content", "detail"];
  for (const role of roles) assert.match(html, new RegExp(`aria-label="${role[0]!.toUpperCase()}${role.slice(1)}"`));
});
