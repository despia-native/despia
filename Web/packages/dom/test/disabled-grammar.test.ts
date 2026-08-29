//
//  disabled-grammar.test.ts — the W9 disabled= / disabled-if= grammar wave: the pair,
//  previously button-family-only, now reaches the interactive control set. Each factory
//  reflects the resolved state into its REAL control(s) as native `disabled`, so CSS
//  state selectors, focusability, and event suppression follow the platform. The
//  button family's define (__DSX_OPTIONAL_DISABLED__) gates the whole grammar.
//
//  Fake-DOM harness (the tooltip.test.ts pattern): factories run against plain fakes;
//  the browser-probe half of the proof rides the W9 Chromium sweep.
//

import { test } from "node:test";
import assert from "node:assert/strict";

import { ReactiveStore, ActionRunner, makeRunEnv, flushEffects } from "@despia/kernel";
import type { XmlNode } from "@despia/compiler/xml";
import type { Registry } from "@despia/compiler/resolve";
import { mountNode, type MountCtx } from "../src/mount.ts";
import { registerRichElements } from "../src/elements.ts";
import { UNIVERSAL_GLOBAL_ELEMENTS } from "../src/globals.ts";
import { registerGlobalElements } from "../src/elements.ts";

class FakeClassList {
  private names = new Set<string>();
  add(...cs: string[]): void { for (const c of cs) this.names.add(c); }
  remove(...cs: string[]): void { for (const c of cs) this.names.delete(c); }
  toggle(): void {}
  contains(c: string): boolean { return this.names.has(c); }
}

class FakeElement {
  tagName: string;
  className = "";
  id = "";
  textContent = "";
  type = "";
  value = "";
  min = "";
  max = "";
  step = "";
  rows = 0;
  checked = false;
  disabled = false;
  hidden = false;
  tabIndex = 0;
  placeholder = "";
  offsetLeft = Number.NaN;
  readonly dataset: { [k: string]: string } = {};
  readonly classList = new FakeClassList();
  readonly styleProps = new Map<string, string>();
  readonly style = {
    setProperty: (k: string, v: string): void => { this.styleProps.set(k, v); },
    removeProperty: (k: string): void => { this.styleProps.delete(k); },
  };
  parent: FakeElement | null = null;
  private attrs = new Map<string, string>();
  kids: FakeElement[] = [];
  constructor(tag: string) { this.tagName = tag.toUpperCase(); }
  setAttribute(k: string, v: string): void { this.attrs.set(k, v); }
  getAttribute(k: string): string | null { return this.attrs.get(k) ?? null; }
  removeAttribute(k: string): void { this.attrs.delete(k); }
  appendChild(c: FakeElement): FakeElement { c.parent = this; this.kids.push(c); return c; }
  append(...cs: FakeElement[]): void { for (const c of cs) this.appendChild(c); }
  replaceChildren(...cs: FakeElement[]): void { this.kids = []; this.append(...cs); }
  remove(): void {
    if (this.parent === null) return;
    this.parent.kids = this.parent.kids.filter((k) => k !== this);
    this.parent = null;
  }
  addEventListener(): void {}
  removeEventListener(): void {}
  querySelector(): null { return null; }
  find(match: (e: FakeElement) => boolean): FakeElement | null {
    if (match(this)) return this;
    for (const kid of this.kids) {
      const hit = kid.find(match);
      if (hit !== null) return hit;
    }
    return null;
  }
  all(match: (e: FakeElement) => boolean, out: FakeElement[] = []): FakeElement[] {
    if (match(this)) out.push(this);
    for (const kid of this.kids) kid.all(match, out);
    return out;
  }
  childAt(i: number): FakeElement {
    const c = this.kids[i];
    if (c === undefined) throw new Error(`no child at ${i}`);
    return c;
  }
}

(globalThis as { document?: unknown }).document = {
  body: new FakeElement("body"),
  createElement: (t: string) => new FakeElement(t),
  createElementNS: (_ns: string, t: string) => new FakeElement(t),
  createComment: (t: string) => new FakeElement(`#comment:${t}`),
  createDocumentFragment: () => new FakeElement("#fragment"),
  addEventListener(): void {},
  removeEventListener(): void {},
};

registerRichElements();
registerGlobalElements(UNIVERSAL_GLOBAL_ELEMENTS);

function mountOne(
  tag: string,
  attrs: { [k: string]: string },
  seed: { [k: string]: unknown } = {},
): { el: FakeElement; store: ReactiveStore } {
  const store = new ReactiveStore();
  for (const [k, v] of Object.entries(seed)) store.set(k, v);
  const env = makeRunEnv(store);
  const registry: Registry = { components: {}, globalPool: {}, css: "", schemes: [] };
  const ctx: MountCtx = {
    registry, scheme: "t", owner: "Test", store, runner: new ActionRunner(env), env,
    item: null, disposers: [], slots: null, rowBinding: null,
  };
  const node: XmlNode = { tag, attrs, children: [], text: "" };
  const parent = new FakeElement("div");
  mountNode(node, ctx, parent as unknown as ParentNode);
  return { el: parent.childAt(0), store };
}

function inputOf(el: FakeElement): FakeElement {
  const hit = el.find((n) => n.tagName === "INPUT");
  assert.ok(hit !== null, "the factory mounts a real input");
  return hit;
}

test("toggle: disabled= reaches the real switch input, reactively", () => {
  const on = mountOne("toggle", { disabled: "true" });
  assert.equal(inputOf(on.el).disabled, true);
  const { el, store } = mountOne("toggle", { "disabled-if": "locked" }, { locked: true });
  assert.equal(inputOf(el).disabled, true);
  store.set("locked", false);
  flushEffects();
  assert.equal(inputOf(el).disabled, false, "a reactive re-enable restores the control");
});

test("slider and textfield and textarea: disabled= reaches the native control", () => {
  const slider = mountOne("slider", { disabled: "true" });
  assert.equal(slider.el.disabled, true, "the slider IS the input");
  const field = mountOne("textfield", { disabled: "true" });
  assert.equal(field.el.disabled, true);
  const area = mountOne("textarea", { disabled: "true" });
  assert.equal(area.el.disabled, true);
  assert.equal(mountOne("textfield", {}).el.disabled, false, "no attribute wires nothing");
});

test("declared disabled= reads the strict component boolean, never JSE truthy", () => {
  // truthy("false") is true by the JSE string law, so the truthy read disabled a control the
  // author explicitly ENABLED (disabled="false") on web and Android while iOS (dsx.bool:
  // `s == "true" || Double(s) != 0`) honored the author. The three renderers now share the
  // predicate; a bound {{ locked }} arrives "1"/"" here, so the empty string stays enabled.
  assert.equal(mountOne("textfield", { disabled: "false" }).el.disabled, false, '"false" is enabled');
  assert.equal(mountOne("textfield", { disabled: "0" }).el.disabled, false, '"0" is enabled');
  assert.equal(mountOne("textfield", { disabled: "" }).el.disabled, false, 'a bound falsy arrives "" - enabled');
  assert.equal(mountOne("textfield", { disabled: "true" }).el.disabled, true, '"true" disables');
  assert.equal(mountOne("textfield", { disabled: "1" }).el.disabled, true, 'a bound truthy arrives "1" - disabled');
});

test("stepper: disabled= forces both steppers beyond the min/max clamp, and releases", () => {
  const { el, store } = mountOne("stepper", { bind: "n", min: "0", max: "10", "disabled-if": "locked" }, { n: 5, locked: true });
  const buttons = el.all((n) => n.tagName === "BUTTON");
  assert.equal(buttons.length, 2);
  assert.ok(buttons.every((b) => b.disabled), "mid-range but forced: both halves disabled");
  store.set("locked", false);
  flushEffects();
  assert.ok(buttons.every((b) => !b.disabled), "released: the clamp truth returns (5 is mid-range)");
});

test("segmented: disabled= disables every option, surviving an options re-render", () => {
  const { el, store } = mountOne("segmented", { options: "A,B,C", bind: "pick", disabled: "true" });
  const options = el.all((n) => n.tagName === "BUTTON");
  assert.equal(options.length, 3);
  assert.ok(options.every((o) => o.disabled));
  store.set("pick", "B");
  flushEffects();
  assert.ok(el.all((n) => n.tagName === "BUTTON").every((o) => o.disabled), "reflect keeps the forced state");
});

test("Checkbox: disabled= reaches the real checkbox input", () => {
  const { el, store } = mountOne("Checkbox", { bind: "ok", label: "Agree", "disabled-if": "locked" }, { locked: true });
  assert.equal(inputOf(el).disabled, true);
  store.set("locked", false);
  flushEffects();
  assert.equal(inputOf(el).disabled, false);
});
