//
//  mount.test.ts — the mount layer's ARIA role contract (wireStyles' a11y block):
//  role= is a BOUND pass-through — an interpolated role resolves against the store
//  (never the raw {{ }} template text, which is a frozen invalid ARIA role) and the
//  guard runs per RESOLVED value: the button role WORDS (system-defaults.md) on a
//  button-family element stay off the ARIA attribute (elements.ts consumes them as
//  data-dsx-role), every other value lands verbatim; the group/heading special cases
//  survive. packages/server/test/render.test.ts pins the SSR twin — the two runners
//  must agree attr-for-attr.
//

import { test } from "node:test";
import assert from "node:assert/strict";

import { ReactiveStore, ActionRunner, makeRunEnv, flushEffects, ModuleRegistry, JSE } from "@despia/kernel";
import type { XmlNode } from "@despia/compiler/xml";
import type { Registry } from "@despia/compiler/resolve";
import { compileComponent } from "@despia/compiler/component";
import { CssCollector, extractComponentCss } from "../../compiler/src/css.ts";
import { mountNode, instantiate, type MountCtx } from "../src/mount.ts";
import { iconSvg, registerGlobalElements, registerRichElements } from "../src/elements.ts";
import { UNIVERSAL_GLOBAL_ELEMENTS } from "../src/globals.ts";
import { DATA_CONTROL_GLOBAL_ELEMENTS, DATA_CONTROL_LIMITS, registerDataControls } from "../src/data-controls.ts";

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
  value = "";
  type = "";
  alt = "";
  src = "";
  placeholder = "";
  rows = 0;
  scope = "";
  tabIndex = 0;
  hidden = false;
  inert = false;
  checked = false;
  disabled = false;
  scrollLeft = 0;
  scrollTop = 0;
  clientWidth = 640;
  clientHeight = 480;
  readonly classList = new FakeClassList(this);
  readonly style = {
    values: new Map<string, string>(),
    setProperty(k: string, v: string): void { this.values.set(k, v); },
    removeProperty(k: string): void { this.values.delete(k); },
  };
  readonly dataset: { [key: string]: string } = {};
  private attrs = new Map<string, string>();
  private kids: FakeElement[] = [];
  private parent: FakeElement | null = null;
  private listeners = new Map<string, Array<(event: FakeEvent) => void>>();
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
  addEventListener(type: string, listener: (event: FakeEvent) => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }
  click(): void {
    if (this.disabled) return;
    const event = new FakeEvent("click");
    for (const listener of this.listeners.get("click") ?? []) listener(event);
  }
  dispatch(type: string): FakeEvent {
    const event = new FakeEvent(type);
    for (const listener of this.listeners.get(type) ?? []) listener(event);
    return event;
  }
  pressKey(key: string): FakeEvent {
    const event = new FakeEvent("keydown", key);
    for (const listener of this.listeners.get("keydown") ?? []) listener(event);
    return event;
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

class FakeEvent {
  defaultPrevented = false;
  readonly type: string;
  readonly key: string;
  constructor(type: string, key = "") { this.type = type; this.key = key; }
  preventDefault(): void { this.defaultPrevented = true; }
  stopPropagation(): void {}
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
(globalThis as { HTMLAnchorElement?: unknown }).HTMLAnchorElement = FakeElement;
(globalThis as { window?: unknown }).window = {
  addEventListener: (): void => {},
  removeEventListener: (): void => {},
};

class FakeIntersectionObserver {
  static readonly instances: FakeIntersectionObserver[] = [];
  private target: FakeElement | null = null;
  private readonly callback: IntersectionObserverCallback;
  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
    FakeIntersectionObserver.instances.push(this);
  }
  observe(target: Element): void { this.target = target as unknown as FakeElement; }
  unobserve(): void { this.target = null; }
  disconnect(): void { this.target = null; }
  takeRecords(): IntersectionObserverEntry[] { return []; }
  trigger(intersecting = true): void {
    if (this.target === null) return;
    this.callback([{ target: this.target, isIntersecting: intersecting } as unknown as IntersectionObserverEntry], this as unknown as IntersectionObserver);
  }
}
(globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = FakeIntersectionObserver;

// ── the harness: a REAL store + runner behind mountNode, so {{ }} bindings are the
//    production makeApi path (staticApi fakes would pass template text through) ──────

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

function mountTree(
  node: XmlNode,
  seed: { [k: string]: unknown } = {},
): { el: FakeElement; store: ReactiveStore; ctx: MountCtx } {
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
  return { el: parent.childAt(0), store, ctx };
}

function xml(tag: string, attrs: Record<string, string> = {}, children: XmlNode[] = []): XmlNode {
  return { tag, attrs, children, text: "" };
}

test("composed invocations add caller presentation to the expanded root without replacing component styling or props", () => {
  const child = compileComponent("Card", "t", `<stack class="card-root" style="padding: 4px">
    <head>
      <attribute as="class"/><attribute as="role"/><attribute as="theme"/>
      <attribute as="grow"/><attribute as="surface"/>
    </head>
    <text value="{{ dsx.attribute.class }}|{{ dsx.attribute.role }}|{{ dsx.attribute.theme }}|{{ dsx.attribute.grow }}|{{ dsx.attribute.surface }}"/>
  </stack>`);
  const caller = compileComponent("Screen", "t", `<stack>
    <head><variable as="skin">return 'consumer-one'</variable></head>
    <Card class="{{ dsx.variable.skin }}"
          role="destructive" theme="dark" grow="width" surface="regular"
          style="margin: 7px; color: {{ dsx.variable.skin == 'consumer-two' ? 'destructive' : 'accent' }}"/>
  </stack>`);
  const collector = new CssCollector();
  extractComponentCss(child, collector);
  extractComponentCss(caller, collector);
  const invocation = caller.root.children[0]!;
  const childHandle = child.root.attrs["__css"]!;
  const callerHandle = invocation.attrs["__css"]!;
  const registry: Registry = {
    components: { "t.Card": child, "t.Screen": caller },
    globalPool: { Card: "t.Card", Screen: "t.Screen" },
    css: collector.emit(),
    schemes: ["t"],
  };

  const instance = instantiate(caller, registry);
  flushEffects();
  const expanded = instance.root.firstElementChild as unknown as FakeElement;
  assert.ok(expanded.classList.contains("card-root"), "component-owned root class survives");
  assert.ok(expanded.classList.contains("consumer-one"), "invocation class decorates a root that does not forward it");
  assert.deepEqual(
    new Set((expanded.getAttribute("data-dsx") ?? "").split(/\s+/)),
    new Set([childHandle, callerHandle]),
    "component and invocation generated-style handles are additive",
  );
  assert.equal(
    expanded.firstElementChild?.textContent,
    "consumer-one|destructive|dark|width|regular",
    "invocation attrs remain normal component props",
  );
  assert.equal(expanded.getAttribute("role"), null, "component-only semantics are not implicitly forwarded");
  assert.equal(expanded.getAttribute("data-dsx-theme"), null);
  assert.equal(expanded.getAttribute("data-dsx-grow"), null);
  assert.ok(!expanded.classList.contains("dsx-surface-regular"));
  assert.equal(expanded.style.values.get("color"), "var(--dsx-accent)");

  instance.ctx.store.set("skin", "consumer-two");
  flushEffects();
  assert.ok(!expanded.classList.contains("consumer-one"));
  assert.ok(expanded.classList.contains("consumer-two"), "invocation class formula stays live");
  assert.equal(expanded.firstElementChild?.textContent, "consumer-two|destructive|dark|width|regular");
  assert.equal(expanded.style.values.get("color"), "var(--dsx-destructive)");
});

test("static non-button role passes through verbatim (and button words stay ARIA off the button family only)", () => {
  assert.equal(mountOne("stack", { role: "tab" }).el.getAttribute("role"), "tab");
  // the WORDS are only consumed by the button family — elsewhere they stay verbatim ARIA pass-through
  assert.equal(mountOne("stack", { role: "destructive" }).el.getAttribute("role"), "destructive");
});

test("canonical buttons preserve declared and reactive disabled gates after hydration", () => {
  const declared = mountOne("button", { label: "Publish", disabled: "true" }).el;
  assert.equal(declared.disabled, true);

  const reactive = mountOne("button", { label: "Publish", "disabled-if": "locked" }, { locked: true });
  assert.equal(reactive.el.disabled, true);
  reactive.store.set("locked", false);
  flushEffects();
  assert.equal(reactive.el.disabled, false);
});

test("disabled linked controls keep their non-focusable state ahead of authored focusOrder", () => {
  const linked = mountOne("button", {
    label: "Open",
    href: "/target",
    disabled: "true",
    focusOrder: "7",
  }).el;
  assert.equal(linked.tagName, "A");
  assert.equal(linked.getAttribute("aria-disabled"), "true");
  assert.equal(linked.tabIndex, -1, "focusOrder cannot overwrite an initially disabled link");
});

test("linked controls compose declared and conditional disabled gates with focusOrder", () => {
  const linked = mountOne("button", {
    label: "Open",
    href: "/target",
    disabled: "{{ dsx.variable.declared }}",
    "disabled-if": "locked",
    focusOrder: "4",
  }, { declared: "", locked: true });

  assert.equal(linked.el.tabIndex, -1, "an initially true disabled-if wins during mount");
  linked.store.set("locked", false);
  flushEffects();
  assert.equal(linked.el.getAttribute("aria-disabled"), null);
  assert.equal(linked.el.tabIndex, 4, "enabling restores the authored traversal order");

  linked.store.set("declared", "true");
  flushEffects();
  assert.equal(linked.el.tabIndex, -1, "the declared gate can disable after hydration");
  linked.store.set("locked", true);
  linked.store.set("declared", "");
  flushEffects();
  assert.equal(linked.el.tabIndex, -1, "either gate independently keeps the link disabled");

  linked.store.set("locked", false);
  flushEffects();
  assert.equal(linked.el.getAttribute("aria-disabled"), null);
  assert.equal(linked.el.tabIndex, 4, "the last cleared gate restores focusOrder exactly");
});

test("interpolated role RESOLVES (never the raw template text) and stays live", () => {
  const { el, store } = mountOne("stack", { role: "{{ dsx.variable.kind }}" }, { kind: "tab" });
  assert.equal(el.getAttribute("role"), "tab", "the resolved value lands, not the {{ }} text");
  store.set("kind", "tablist");
  flushEffects();
  assert.equal(el.getAttribute("role"), "tablist", "the binding re-resolves on a store write");
});

test("adaptive scaffold moves one mounted child tree across a reactive custom/automatic shell", () => {
  const store = new ReactiveStore();
  store.set("shellMode", "custom");
  store.set("collapseMode", "none");
  const env = makeRunEnv(store);
  const registry: Registry = { components: {}, globalPool: {}, css: "", schemes: [] };
  const ctx: MountCtx = {
    registry, scheme: "t", owner: "Test", store, runner: new ActionRunner(env), env,
    item: null, disposers: [], slots: null, rowBinding: null,
  };
  const node: XmlNode = {
    tag: "scaffold",
    attrs: {
      shell: "{{ dsx.variable.shellMode }}",
      collapse: "{{ dsx.variable.collapseMode }}",
    },
    text: "",
    children: [
      { tag: "text", attrs: { pane: "sidebar", value: "Library" }, children: [], text: "" },
      { tag: "text", attrs: { pane: "content", value: "Now Playing" }, children: [], text: "" },
      { tag: "text", attrs: { pane: "inspector", value: "Details" }, children: [], text: "" },
    ],
  };
  const parent = new FakeElement("div");
  mountNode(node, ctx, parent as unknown as ParentNode);

  const scaffoldRoot = parent.childAt(0);
  const shell = scaffoldRoot.childAt(0);
  const custom = shell.childAt(0);
  const sidebar = shell.childAt(1);
  const content = shell.childAt(2);
  const inspector = shell.childAt(3);
  assert.equal(shell.dataset["dsxMode"], "custom");
  assert.equal(custom.childAt(1).textContent, "Library");
  assert.equal(custom.childAt(4).textContent, "Now Playing");
  assert.equal(custom.childAt(7).textContent, "Details");

  store.set("shellMode", "automatic");
  flushEffects();
  assert.equal(shell.dataset["dsxMode"], "automatic");
  assert.equal(shell.dataset["dsxCollapse"], "none");
  assert.equal(sidebar.childAt(1).textContent, "Library");
  assert.equal(content.childAt(1).textContent, "Now Playing");
  assert.equal(inspector.childAt(1).textContent, "Details");

  store.set("shellMode", "custom");
  flushEffects();
  assert.equal(shell.dataset["dsxMode"], "custom");
  assert.equal(custom.childAt(1).textContent, "Library");
  assert.equal(custom.childAt(4).textContent, "Now Playing");
  assert.equal(custom.childAt(7).textContent, "Details");
});

test("button role WORDS are suppressed as ARIA on the whole button family (static)", () => {
  for (const tag of ["button", "glassButton", "transport", "pressable", "row"]) {
    const { el } = mountOne(tag, { label: "Delete", role: "destructive" });
    assert.equal(el.getAttribute("data-dsx-role"), "destructive", `${tag}: the skin stamp lands`);
    assert.equal(el.getAttribute("role"), null, `${tag}: the word never mints an ARIA role`);
  }
});

test("fixture aliases retain canonical content and progress semantics", () => {
  const row = mountTree(xml("row", {}, [xml("text", { value: "Arbitrary row content" })])).el;
  assert.ok(row.classList.contains("dsx-pressable"));
  assert.equal(row.childAt(0).textContent, "Arbitrary row content");

  const slottedButton = mountTree(xml("button", {}, [xml("text", { value: "Slotted action" })])).el;
  assert.equal(slottedButton.childAt(0).textContent, "Slotted action");
  assert.ok(mountOne("transport", { icon: "star" }).el.classList.contains("dsx-button"));

  const capsule = mountOne("capsuleProgress", { value: "0.5" }).el;
  assert.equal(capsule.getAttribute("role"), "progressbar");
  assert.equal(capsule.getAttribute("aria-valuemin"), "0");
  assert.equal(capsule.getAttribute("aria-valuemax"), "1");
  assert.equal(capsule.getAttribute("aria-valuenow"), "0.5");
});

test("canonical layout attributes and scroll direction stay live in the DOM", () => {
  const layout = mountOne("stack", {
    flexDirection: "{{ dsx.variable.direction }}",
    alignItems: "{{ dsx.variable.alignment }}",
    display: "{{ dsx.variable.display }}",
  }, { direction: "row", alignment: "flex-end", display: "grid" });
  assert.equal(layout.el.style.values.get("flex-direction"), "row");
  assert.equal(layout.el.style.values.get("align-items"), "flex-end");
  assert.equal(layout.el.style.values.get("display"), "grid");
  assert.ok(layout.el.classList.contains("dsx-hstack"), "row stacks expose their main axis to grow rules");
  assert.equal(layout.el.getAttribute("data-dsx-grid"), "true", "grid stacks overlap their children");

  layout.store.set("direction", "column");
  layout.store.set("display", "flex");
  flushEffects();
  assert.equal(layout.el.style.values.get("flex-direction"), "column");
  assert.ok(!layout.el.classList.contains("dsx-hstack"));
  assert.equal(layout.el.getAttribute("data-dsx-grid"), null);
  layout.store.set("direction", "sideways");
  layout.store.set("alignment", "url(javascript:bad)");
  layout.store.set("display", "block");
  flushEffects();
  assert.equal(layout.el.style.values.get("flex-direction"), undefined, "invalid reactive direction clears stale style");
  assert.equal(layout.el.style.values.get("align-items"), undefined, "invalid reactive alignment clears stale style");
  assert.equal(layout.el.style.values.get("display"), undefined, "invalid reactive display clears stale style");

  const scroll = mountOne("scroll", { direction: "{{ dsx.variable.axis }}" }, { axis: "horizontal" });
  assert.ok(scroll.el.classList.contains("dsx-scroll-x"));
  scroll.store.set("axis", "vertical");
  flushEffects();
  assert.ok(!scroll.el.classList.contains("dsx-scroll-x"));
});

test("authored semantic colors and spinner scale reach component chrome", () => {
  const cases: Array<[tag: string, property: string]> = [
    ["divider", "--dsx-divider-color"],
    ["toggle", "--dsx-control-tint"],
    ["slider", "--dsx-control-tint"],
    ["spinner", "--dsx-spinner-color"],
    ["stepper", "--dsx-stepper-color"],
  ];
  for (const [tag, property] of cases) {
    const { el } = mountOne(tag, { color: "secondary" });
    assert.equal(el.style.values.get(property), "var(--dsx-secondary-label)", `${tag}: semantic tint reaches chrome`);
  }
  const spinner = mountOne("spinner", { scale: "{{ dsx.variable.scale }}" }, { scale: 1.75 });
  assert.equal(spinner.el.style.values.get("--dsx-spinner-scale"), "1.75");
  spinner.store.set("scale", Number.POSITIVE_INFINITY);
  flushEffects();
  assert.equal(spinner.el.style.values.get("--dsx-spinner-scale"), "1", "non-finite scale returns to the safe default");
  spinner.store.set("scale", -5);
  flushEffects();
  assert.equal(spinner.el.style.values.get("--dsx-spinner-scale"), "0.25", "negative scale cannot flip or hide the spinner");
  spinner.store.set("scale", 1e100);
  flushEffects();
  assert.equal(spinner.el.style.values.get("--dsx-spinner-scale"), "4", "hostile scale cannot explode the viewport");

  registerGlobalElements(UNIVERSAL_GLOBAL_ELEMENTS);
  const checkbox = mountOne("Checkbox", { bind: "checked", color: "destructive" }, { checked: true }).el;
  assert.equal(checkbox.style.values.get("--dsx-checkbox-color"), "var(--dsx-destructive)");
});

test("stepper exposes a named value group and action-specific button names", () => {
  const stepper = mountOne("stepper", {
    bind: "dsx.variable.quantity",
    label: "{{ dsx.variable.label }}",
  }, { quantity: 2, label: "Quantity" });
  assert.equal(stepper.el.getAttribute("role"), "group");
  assert.equal(stepper.el.getAttribute("aria-label"), "Quantity");
  // `label=` is a VISIBLE caption (Stepper.swift:19 renders it as the control's own
  // label view), so the authored anatomy is caption · − · value · +.
  assert.equal(stepper.el.childAt(0).getAttribute("data-dsx-part"), "label");
  assert.equal(stepper.el.childAt(0).textContent, "Quantity");
  assert.equal(stepper.el.childAt(0).hidden, false);
  assert.equal(stepper.el.childAt(1).getAttribute("aria-label"), "Decrease Quantity");
  assert.equal(stepper.el.childAt(2).getAttribute("aria-live"), "polite");
  assert.equal(stepper.el.childAt(2).textContent, "2");
  assert.equal(stepper.el.childAt(3).getAttribute("aria-label"), "Increase Quantity");
  stepper.store.set("label", "Guests");
  flushEffects();
  assert.equal(stepper.el.getAttribute("aria-label"), "Guests");
  assert.equal(stepper.el.childAt(0).textContent, "Guests");
  assert.equal(stepper.el.childAt(3).getAttribute("aria-label"), "Increase Guests");
  stepper.store.set("quantity", 0);
  flushEffects();
  assert.equal(stepper.el.childAt(1).disabled, true);
  assert.equal(stepper.el.childAt(3).disabled, false);
  stepper.el.childAt(1).click();
  assert.equal(stepper.store.getPath("quantity"), 0, "the fixture default minimum is zero");
  stepper.store.set("quantity", 100);
  flushEffects();
  assert.equal(stepper.el.childAt(1).disabled, false);
  assert.equal(stepper.el.childAt(3).disabled, true);
  stepper.el.childAt(3).click();
  assert.equal(stepper.store.getPath("quantity"), 100, "the fixture default maximum is one hundred");
});

test("an unlabelled stepper mounts NO caption element; an empty label hides it", () => {
  const bare = mountOne("stepper", { bind: "dsx.variable.n" }, { n: 1 });
  assert.equal(bare.el.childAt(0).getAttribute("data-dsx-part"), null,
    "no label= authored: the anatomy stays exactly - value +");
  assert.equal(bare.el.getAttribute("aria-label"), "Value");
  const captioned = mountOne("stepper", {
    bind: "dsx.variable.n",
    label: "{{ dsx.variable.caption }}",
  }, { n: 1, caption: "Seats" });
  assert.equal(captioned.el.childAt(0).hidden, false);
  captioned.store.set("caption", "  ");
  flushEffects();
  assert.equal(captioned.el.childAt(0).hidden, true, "a blank caption hides rather than reserving space");
});

test("stepper boundary actions disable after user and programmatic value changes", () => {
  const stepper = mountOne("stepper", {
    bind: "dsx.variable.quantity",
    min: "-2",
    max: "2",
    step: "2",
  }, { quantity: 0 });
  const minus = stepper.el.childAt(0);
  const value = stepper.el.childAt(1);
  const plus = stepper.el.childAt(2);

  assert.equal(minus.disabled, false);
  assert.equal(plus.disabled, false);

  minus.click();
  assert.equal(stepper.store.getPath("quantity"), -2);
  assert.equal(value.textContent, "-2");
  assert.equal(minus.disabled, true, "a user decrement disables the newly exhausted action immediately");
  assert.equal(plus.disabled, false);

  plus.click();
  assert.equal(stepper.store.getPath("quantity"), 0);
  assert.equal(value.textContent, "0");
  assert.equal(minus.disabled, false, "moving away from the minimum re-enables decrement");
  assert.equal(plus.disabled, false);

  stepper.store.set("quantity", 2);
  flushEffects();
  assert.equal(minus.disabled, false);
  assert.equal(plus.disabled, true, "a programmatic maximum disables increment");

  stepper.store.set("quantity", -20);
  flushEffects();
  assert.equal(minus.disabled, true, "an out-of-range programmatic low value remains safely bounded");
  assert.equal(plus.disabled, false);

  stepper.store.set("quantity", 20);
  flushEffects();
  assert.equal(minus.disabled, false);
  assert.equal(plus.disabled, true, "an out-of-range programmatic high value remains safely bounded");
});

test("interpolated role is guarded per RESOLVED value — a word suppresses, a real role lands, flips track", () => {
  const { el, store } = mountOne(
    "button",
    { label: "Del", role: "{{ dsx.variable.danger ? 'destructive' : 'tab' }}" },
    { danger: true },
  );
  assert.equal(el.getAttribute("role"), null, "resolved button word: no ARIA role");
  assert.equal(el.getAttribute("data-dsx-role"), "destructive", "resolved button word: the skin stamp");
  store.set("danger", false);
  flushEffects();
  assert.equal(el.getAttribute("role"), "tab", "resolved non-word: verbatim ARIA pass-through");
  assert.equal(el.getAttribute("data-dsx-role"), null, "the skin stamp cleared on the flip");
});

test("the group/heading special cases survive the bound pass-through", () => {
  assert.equal(mountOne("stack", { role: "group" }).el.getAttribute("role"), "group");
  const h = mountOne("stack", { a11yTrait: "header", role: "tab" }).el;
  assert.equal(h.getAttribute("role"), "heading", "a11yTrait=header owns the role");
  assert.equal(h.getAttribute("aria-level"), "2");
});

test("bound pressed state is semantic, reactive, and rejects invalid ARIA values", () => {
  const { el, store } = mountOne(
    "pressable",
    { label: "Filter", "aria-pressed": "{{ dsx.variable.selected }}" },
    { selected: true },
  );
  assert.equal(el.getAttribute("aria-pressed"), "true");
  store.set("selected", false);
  flushEffects();
  assert.equal(el.getAttribute("aria-pressed"), "false");
  store.set("selected", "not-a-state");
  flushEffects();
  assert.equal(el.getAttribute("aria-pressed"), null);
});

test("authored classes survive every Launcher mounting path", () => {
  // The responsive Demo stylesheet addresses these author classes directly. Keep
  // the ordinary builtin path, the keyed-list special path, and a pressable row in
  // one regression: losing any one silently collapses the desktop grid to a mobile
  // column even though the compiled CSS is still present.
  assert.ok(mountOne("stack", { class: "launcher-content extra" }).el.classList.contains("launcher-content"));
  assert.ok(mountOne("text", { class: "launcher-desktop-title", value: "DSX demo" }).el.classList.contains("launcher-desktop-title"));
  assert.ok(mountOne("list", {
    class: "launcher-grid",
    bind: "dsx.variable.pages",
  }, { pages: [] }).el.classList.contains("launcher-grid"));
  assert.ok(mountOne("pressable", { class: "launcher-row", label: "Gallery" }).el.classList.contains("launcher-row"));
});

test("bound lists cap hostile input and preserve keyed row/focus identity while item bindings refresh", () => {
  const source = [
    { id: "a", label: "Alpha" },
    { id: "b", label: "Beta" },
  ];
  const { el, store } = mountTree(
    xml("list", { bind: "rows", key: "id" }, [xml("textfield", { bind: "item.label" })]),
    { rows: source },
  );
  const alphaRow = el.childAt(0);
  const alphaInput = alphaRow.childAt(0);
  alphaInput.focus();
  store.set("rows", [
    { id: "b", label: "Beta 2" },
    { id: "a", label: "Alpha 2" },
  ]);
  flushEffects();
  assert.equal(el.childAt(1), alphaRow, "keyed reorder moves, rather than remounts, the row node");
  assert.equal(alphaInput.value, "Alpha 2", "item-local bindings refresh on the preserved row");
  assert.equal(fakeDocument.activeElement, alphaInput, "focused descendants survive keyed reordering");

  const previousWarn = console.warn;
  console.warn = () => {};
  try {
    store.set("rows", Array.from({ length: 100_000 }, (_, id) => ({ id, label: String(id) })));
    flushEffects();
  } finally {
    console.warn = previousWarn;
  }
  assert.equal(el.childCount, 1_000, "100k hostile rows allocate at most the public live-DOM budget");
  assert.equal(el.getAttribute("data-dsx-truncated"), "true");
  assert.equal(el.getAttribute("data-dsx-total-count"), "100000");
  assert.equal(el.getAttribute("data-dsx-rendered-count"), "1000");
});

test("bound reconciliation never recursively fingerprints or eagerly enumerates hostile row objects", () => {
  const raw: Record<string, unknown> = { id: "cycle", label: "Safe" };
  raw["self"] = raw;
  const hostile = new Proxy(raw, {
    ownKeys: () => { throw new Error("row was eagerly enumerated"); },
  });
  const { el } = mountTree(
    xml("list", { bind: "rows", key: "id" }, [xml("text", { value: "{{ item.label }}" })]),
    { rows: [hostile] },
  );
  assert.equal(el.childAt(0).childAt(0).textContent, "Safe");
});

test("bound grids expose grid > row > gridcell ownership and finite row metadata", () => {
  const { el } = mountTree(
    xml("grid", { bind: "rows", key: "id", columns: "2" }, [xml("text", { value: "{{ item.id }}" })]),
    { rows: Array.from({ length: 5 }, (_, id) => ({ id })) },
  );
  assert.equal(el.getAttribute("role"), "grid");
  assert.equal(el.getAttribute("aria-colcount"), "2");
  assert.equal(el.getAttribute("aria-rowcount"), "3");
  assert.equal(el.childCount, 3);
  assert.equal(el.childAt(0).getAttribute("role"), "row");
  assert.equal(el.childAt(0).childAt(0).getAttribute("role"), "gridcell");
  assert.equal(el.childAt(0).childAt(1).getAttribute("aria-colindex"), "2");
});

test("bound pagers use page semantics, dots, keyboard and independent value writeback", () => {
  const { el, store } = mountTree(
    xml("pager", { bind: "pages", key: "id", value: "page", axis: "horizontal" }, [
      xml("text", { value: "{{ item.title }}" }),
    ]),
    { page: 1, pages: [{ id: "a", title: "A" }, { id: "b", title: "B" }, { id: "c", title: "C" }] },
  );
  const viewport = el.childAt(0);
  const track = viewport.childAt(0);
  const dots = el.childAt(1);
  assert.equal(el.tagName, "SECTION");
  assert.equal(el.getAttribute("aria-roledescription"), "carousel");
  assert.equal(el.getAttribute("data-dsx-page"), "1");
  assert.equal(track.childCount, 3);
  assert.equal(track.childAt(1).getAttribute("aria-roledescription"), "slide");
  assert.equal(dots.childCount, 3);
  assert.equal(el.getAttribute("data-dsx-truncated"), "false");
  assert.equal(el.getAttribute("data-dsx-total-count"), "3");
  dots.childAt(2).click();
  assert.equal(store.eval("page", null), 2);
  assert.equal(el.getAttribute("data-dsx-page"), "2");
  const key = viewport.pressKey("Home");
  assert.equal(key.defaultPrevented, true);
  assert.equal(store.eval("page", null), 0);
  assert.equal(viewport.scrollLeft, 0);
});

test("reachEnd observes only the real terminal row and fires once per terminal dataset", async () => {
  FakeIntersectionObserver.instances.length = 0;
  const { store } = mountTree(
    xml("list", { bind: "rows", key: "id", "on:reachEnd": "hits = hits + 1" }, [
      xml("text", { value: "{{ item.id }}" }),
    ]),
    { hits: 0, rows: [{ id: 1 }, { id: 2 }] },
  );
  assert.equal(FakeIntersectionObserver.instances.length, 1);
  FakeIntersectionObserver.instances[0]!.trigger();
  FakeIntersectionObserver.instances[0]!.trigger();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.equal(store.eval("hits", null), 1);
  store.set("rows", [{ id: 1 }, { id: 2 }, { id: 3 }]);
  flushEffects();
  assert.equal(FakeIntersectionObserver.instances.length, 2);
  FakeIntersectionObserver.instances[1]!.trigger();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.equal(store.eval("hits", null), 2);
});

// ── the L-01 list constructs (Conformance/elements/list.json `notes` is the contract) ──

test("group_by sections a bound list in FIRST-SEEN order, header = the stringified field", () => {
  const { el, store } = mountTree(
    xml("list", { bind: "rows", key: "id", group_by: "cat" }, [xml("text", { value: "{{ item.id }}" })]),
    {
      rows: [
        { id: "a", cat: "Fruit" }, { id: "b", cat: "Veg" },
        { id: "c", cat: "Fruit" }, { id: "d", cat: "" },
      ],
    },
  );
  assert.equal(el.getAttribute("data-dsx-grouped"), "true");
  assert.equal(el.childCount, 3, "one section per first-seen group value");
  const fruit = el.childAt(0);
  assert.equal(fruit.getAttribute("role"), "group");
  assert.equal(fruit.getAttribute("aria-label"), "Fruit");
  assert.equal(fruit.childAt(0).getAttribute("data-dsx-part"), "section-header");
  assert.equal(fruit.childAt(0).textContent, "Fruit");
  assert.equal(fruit.childAt(0).getAttribute("aria-hidden"), "true", "the group NAME is the announcement, not the header text");
  assert.equal(fruit.childCount, 3, "header + the two Fruit rows, in first-seen row order");
  assert.equal(fruit.childAt(1).childAt(0).textContent, "a");
  assert.equal(fruit.childAt(2).childAt(0).textContent, "c");
  assert.equal(el.childAt(1).getAttribute("aria-label"), "Veg");
  assert.equal(el.childAt(2).getAttribute("aria-label"), "", "a missing field groups under the empty value");

  // a grouped list is FLAT again the moment the field goes away
  store.set("rows", [{ id: "a", cat: "Fruit" }]);
  flushEffects();
  assert.equal(el.childCount, 1);
  assert.equal(el.childAt(0).getAttribute("role"), "group");
});

test("group_by stands down under scroll=\"false\" and a horizontal axis, exactly like List.swift", () => {
  const fit = mountTree(
    xml("list", { bind: "rows", key: "id", group_by: "cat", scroll: "false" }, [xml("text", { value: "x" })]),
    { rows: [{ id: "a", cat: "Fruit" }] },
  );
  assert.equal(fit.el.getAttribute("data-dsx-grouped"), "false");
  assert.equal(fit.el.childAt(0).getAttribute("role"), "listitem");
  const rail = mountTree(
    xml("list", { bind: "rows", key: "id", group_by: "cat", axis: "horizontal" }, [xml("text", { value: "x" })]),
    { rows: [{ id: "a", cat: "Fruit" }] },
  );
  assert.equal(rail.el.getAttribute("data-dsx-grouped"), "false");
  assert.equal(rail.el.childAt(0).getAttribute("role"), "listitem");
});

test("swipe actions render a real button rail and fire the list's on:<event> with the ROW as scope", async () => {
  const { el, store } = mountTree(
    xml("list", {
      bind: "rows", key: "id",
      swipeTrailing: "actions",
      "on:delete": "removed = id",
    }, [xml("text", { value: "{{ item.label }}" })]),
    {
      removed: "",
      rows: [{ id: "a", label: "Alpha" }, { id: "b", label: "Beta" }],
      actions: [
        { label: "Archive", icon: "star", event: "archive" },
        { title: "Delete", role: "destructive", color: "#FF0000", event: "delete" },
      ],
    },
  );
  assert.equal(el.getAttribute("data-dsx-swipeable"), "true");
  const row = el.childAt(0);
  assert.ok(row.classList.contains("dsx-row-constructs"));
  const host = row.childAt(0);
  assert.equal(host.getAttribute("data-dsx-part"), "row-host");
  const content = host.childAt(0);
  assert.equal(content.getAttribute("data-dsx-part"), "row-content");
  assert.equal(content.childAt(0).textContent, "Alpha", "the row TEMPLATE mounts into the sliding content");
  const trailing = host.childAt(1);
  assert.equal(trailing.getAttribute("data-dsx-part"), "actions-trailing");
  assert.equal(trailing.childCount, 2);
  assert.equal(trailing.childAt(1).getAttribute("data-dsx-role"), "destructive");
  assert.equal(trailing.childAt(1).style.values.get("--dsx-list-action-tint"), "#FF0000");

  trailing.childAt(1).click();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.equal(store.eval("removed", null), "a", "the ROW's fields read top-level in the handler scope");
  assert.equal(host.getAttribute("data-dsx-swipe"), "closed", "committing an action closes the row");
});

test("reorder writes the moved array back through the bind seam and fires on:move with FINAL indices", async () => {
  const { el, store } = mountTree(
    xml("list", {
      bind: "rows", key: "id", reorder: "true",
      "on:move": "moves = from + '>' + to",
    }, [xml("text", { value: "{{ item.id }}" })]),
    { moves: "", rows: [{ id: "a" }, { id: "b" }, { id: "c" }] },
  );
  assert.equal(el.getAttribute("data-dsx-reorder"), "true");
  const handle = el.childAt(0).childAt(0).childAt(0).childAt(0);
  assert.equal(handle.getAttribute("data-dsx-part"), "reorder");
  assert.equal(handle.getAttribute("aria-label"), "Reorder");
  const event = handle.pressKey("ArrowDown");
  assert.equal(event.defaultPrevented, true);
  flushEffects();
  assert.deepEqual(store.eval("rows", null), [{ id: "b" }, { id: "a" }, { id: "c" }]);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.equal(store.eval("moves", null), "0>1");

  // the FIRST row cannot move up — no write, no event
  const first = el.childAt(0).childAt(0).childAt(0).childAt(0);
  first.pressKey("ArrowUp");
  flushEffects();
  assert.deepEqual(store.eval("rows", null), [{ id: "b" }, { id: "a" }, { id: "c" }]);
});

test("one mode per list: a grouped list ignores reorder, and an active reorder suppresses swipe", () => {
  const grouped = mountTree(
    xml("list", { bind: "rows", key: "id", group_by: "cat", reorder: "true" }, [xml("text", { value: "x" })]),
    { rows: [{ id: "a", cat: "F" }] },
  );
  assert.equal(grouped.el.getAttribute("data-dsx-reorder"), "false", "moving across computed sections is ill-defined");

  const both = mountTree(
    xml("list", { bind: "rows", key: "id", reorder: "{{ editing }}", swipeTrailing: "actions" },
      [xml("text", { value: "x" })]),
    { editing: true, rows: [{ id: "a" }], actions: [{ label: "Delete", event: "delete" }] },
  );
  assert.equal(both.el.getAttribute("data-dsx-reorder"), "true");
  assert.equal(both.el.getAttribute("data-dsx-swipeable"), "false");
  const host = both.el.childAt(0).childAt(0);
  assert.equal(host.childAt(1).hidden, true, "the rail is not reachable while drag handles are active");
  assert.equal(host.childAt(0).childAt(0).hidden, false, "the handle IS");

  both.store.set("editing", false);
  flushEffects();
  assert.equal(both.el.getAttribute("data-dsx-reorder"), "false");
  assert.equal(both.el.getAttribute("data-dsx-swipeable"), "true");
  assert.equal(host.childAt(1).hidden, false);
  assert.equal(host.childAt(0).childAt(0).hidden, true);
});

test("autoscroll declares its marquee state; a host with no animation frame stands down honestly", () => {
  const { el } = mountTree(
    xml("list", { bind: "rows", key: "id", axis: "horizontal", autoscroll: "40" }, [xml("text", { value: "x" })]),
    { rows: [{ id: "a" }, { id: "b" }] },
  );
  // node has no requestAnimationFrame: the rail renders, the marquee reports it is off
  assert.equal(el.getAttribute("data-dsx-autoscroll"), "false");
  assert.equal(el.getAttribute("data-dsx-axis"), "horizontal");
  assert.equal(el.childCount, 2);
});

test("surface material is universal, reactive, bounded, and survives class formulas", () => {
  const { el, store } = mountOne(
    "stack",
    {
      surface: "{{ dsx.variable.material }}",
      class: "shell {{ dsx.variable.emphasis }}",
    },
    { material: "thin", emphasis: "quiet" },
  );
  assert.ok(el.classList.contains("dsx-surface-thin"));
  assert.ok(el.classList.contains("quiet"));

  store.set("emphasis", "active");
  flushEffects();
  assert.ok(el.classList.contains("dsx-surface-thin"), "an authored class update keeps renderer state classes");
  assert.ok(!el.classList.contains("quiet"));
  assert.ok(el.classList.contains("active"));

  store.set("material", "regular");
  flushEffects();
  assert.ok(!el.classList.contains("dsx-surface-thin"));
  assert.ok(el.classList.contains("dsx-surface-regular"));

  store.set("material", "thin thick");
  flushEffects();
  assert.ok(!el.classList.contains("dsx-surface-regular"), "unknown/compound remote values fail open");
  assert.ok(!el.classList.contains("dsx-surface-thin"));
  assert.ok(!el.classList.contains("dsx-surface-thick"));
});

test("device-agnostic Live and Watch preview symbols have deterministic web adapters", () => {
  const names = [
    "takeoutbag.and.cup.and.straw.fill",
    "car.fill",
    "cup.and.saucer.fill",
    "airplane",
    "applewatch",
    "applewatch.watchface",
    "gyroscope",
  ];
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (message?: unknown): void => { warnings.push(String(message)); };
  try {
    for (const name of names) {
      const svg = iconSvg(name, 16) as unknown as FakeElement;
      assert.equal(svg.getAttribute("width"), "16", `${name}: adapter emitted an SVG`);
      assert.ok(svg.childAt(0).getAttribute("d"), `${name}: adapter emitted a real path`);
    }
  } finally {
    console.warn = originalWarn;
  }
  assert.deepEqual(warnings, [], "known DSX previews never hit the unknown-icon fallback");
});

test("segmented click writes the requested value before on:change and reflects exactly one radio", async () => {
  registerRichElements();
  const { el: group, store } = mountOne(
    "segmented",
    {
      bind: "dsx.variable.mode",
      options: "system,light,dark",
      "on:change": "dsx.variable.observed = dsx.variable.mode",
    },
    { mode: "dark", observed: "unset" },
  );
  const system = group.childAt(0);
  const light = group.childAt(1);
  const dark = group.childAt(2);

  assert.equal(dark.getAttribute("aria-checked"), "true", "the bound dark seed is selected");
  system.click();
  await new Promise<void>((resolve) => setImmediate(resolve));
  flushEffects();

  assert.equal(store.getPath("mode"), "system", "clicking system writes system, never its light resolution");
  assert.equal(store.getPath("observed"), "system", "on:change observes the already-written bind value");
  assert.equal(system.getAttribute("aria-checked"), "true");
  assert.equal(light.getAttribute("aria-checked"), "false");
  assert.equal(dark.getAttribute("aria-checked"), "false");
});

test("segmented roving radio keyboard wraps and Home/End select exact options", () => {
  registerRichElements();
  const { el: group, store } = mountOne(
    "segmented",
    { bind: "dsx.variable.mode", options: "system,light,dark" },
    { mode: "dark" },
  );

  assert.equal(group.pressKey("ArrowRight").defaultPrevented, true);
  assert.equal(store.getPath("mode"), "system", "ArrowRight wraps dark to system");
  assert.equal(group.childAt(0).getAttribute("aria-checked"), "true");

  assert.equal(group.pressKey("End").defaultPrevented, true);
  assert.equal(store.getPath("mode"), "dark");
  assert.equal(group.childAt(2).getAttribute("aria-checked"), "true");

  assert.equal(group.pressKey("Home").defaultPrevented, true);
  assert.equal(store.getPath("mode"), "system");
  assert.equal(group.childAt(0).getAttribute("aria-checked"), "true");
});

test("universal native globals mount as semantic web elements, never unresolved placeholders", () => {
  registerGlobalElements(UNIVERSAL_GLOBAL_ELEMENTS);
  const cases: Array<[tag: string, attrs: { [k: string]: string }, cls: string]> = [
    ["Checkbox", { bind: "dsx.variable.checked", label: "Terms" }, "dsx-checkbox"],
    ["ProgressRing", { value: "0.5", label: "50%" }, "dsx-progress-ring"],
    ["Skeleton", {}, "dsx-skeleton"],
    ["ChatBubble", { value: "Hello", side: "right" }, "dsx-chat-bubble"],
    ["Accordion", { title: "Details" }, "dsx-accordion"],
  ];
  for (const [tag, attrs, cls] of cases) {
    const { el } = mountOne(tag, attrs, { checked: false });
    assert.ok(el.classList.contains(cls), `${tag} mounts with ${cls}`);
    assert.ok(!el.classList.contains("dsx-unsupported"), `${tag} is not a fallback`);
  }
  const defaultRing = mountOne("ProgressRing", { value: "0.5" }).el;
  const defaultSkeleton = mountOne("Skeleton", {}).el;
  const defaultBubble = mountOne("ChatBubble", { value: "Hello", side: "right" }).el;
  const defaultAccordion = mountOne("Accordion", { title: "Details" }).el;
  assert.equal(defaultRing.getAttribute("role"), "progressbar");
  assert.equal(defaultRing.style.values.get("--dsx-ring-size"), undefined, "weak CSS owns default ring geometry");
  assert.equal(defaultSkeleton.style.values.get("--dsx-skeleton-height"), undefined, "weak CSS owns default skeleton geometry");
  assert.equal(defaultBubble.style.values.get("--dsx-chat-color"), undefined, "weak CSS owns the accessible bubble palette");
  assert.equal(defaultBubble.style.values.get("--dsx-chat-max"), undefined, "weak CSS owns default bubble width");
  assert.equal(defaultAccordion.childAt(0).getAttribute("aria-expanded"), "false");
  assert.equal(defaultAccordion.childAt(0).childAt(1).style.values.get("color"), undefined,
    "weak CSS owns the default accordion accent");
});

test("capitalized WebView routes to the reserved primitive before component lookup", () => {
  registerRichElements();
  const { el } = mountOne("WebView", { name: "testsurface", src: "about:blank" });
  assert.equal(el.tagName, "IFRAME");
  assert.ok(el.classList.contains("dsx-webview"));
  assert.ok(!el.classList.contains("dsx-unsupported"));
});

test("ephemeral WebView uses an opaque sandbox origin on every browser", () => {
  const { el } = mountOne("WebView", { name: "private", src: "about:blank", ephemeral: "true" });
  const sandbox = el.getAttribute("sandbox") ?? "";
  assert.ok(sandbox.includes("allow-scripts"), "the isolated page remains functional");
  assert.ok(!sandbox.includes("allow-same-origin"), "cookies/storage cannot inherit an accessible origin");
});

// ── visible-if="has:scheme" — the capability-check special form (module availability;
//    the Stack.swift `env.has` / StackNodeView.kt twin: stripped BEFORE JSE, scheme
//    trimmed, answered by the availability plane — never the store) ──────────────────

function mountRoot(attrs: { [k: string]: string }): FakeElement {
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
  return parent;
}

test("visible-if=has: mounts iff the module is available — never JSE, no anchor when absent", () => {
  ModuleRegistry.register({ scheme: "scanner", actions: {} });
  const on = mountRoot({ "visible-if": "has:scanner", role: "tab" });
  assert.equal(on.childAt(0).getAttribute("role"), "tab", "available: the element mounts, other attrs intact");
  assert.equal(on.childAt(0).getAttribute("visible-if"), null, "the special form never lands as an attribute");
  const off = mountRoot({ "visible-if": "has:notinstalled" });
  assert.throws(() => off.childAt(0), /no child/, "unavailable: nothing mounts — no element, not even the dsx:if anchor");
});

test("visible-if=has: trims the scheme like the native twins", () => {
  ModuleRegistry.register({ scheme: "trimcam", actions: {} });
  const parent = mountRoot({ "visible-if": "has: trimcam " });
  assert.equal(parent.childAt(0).tagName, "DIV", "whitespace around the scheme is trimmed (Stack.swift/StackNodeView.kt behavior)");
});

// ── <functions global="true"> — the global-function-library head block wires at mount
//    (compiler globalScripts → JSE.registerGlobalFunctions; corpus Conformance/functions) ──

test("instantiate registers <functions global> app-wide and the body renders through it", () => {
  const ir = compileComponent("GFn", "t",
    `<stack>
       <head><functions global="true">function gtaxweb(n) { return n * 0.2 }</functions></head>
       <text value="{{ gtaxweb(50) }}"/>
     </stack>`);
  const registry: Registry = { components: { "t.GFn": ir }, globalPool: {}, css: "", schemes: [] };
  const instance = instantiate(ir, registry);
  const text = (instance.root as unknown as FakeElement).childAt(0);
  assert.equal(text.textContent, "10", "the interpolation resolves through the global table");
  const other = new ReactiveStore();
  assert.equal(JSE.eval("gtaxweb(50)", other.jse, null), 10, "a SECOND surface shares the app-wide table");
  JSE.clearGlobalFunctions();
});

test("embed API diet skips declarative transport only when the closed slice disables it", () => {
  const globals = globalThis as typeof globalThis & { __DSX_OPTIONAL_APIS__?: boolean };
  const previous = globals.__DSX_OPTIONAL_APIS__;
  const ir = compileComponent(
    "ApiDiet",
    "t",
    `<stack><head><api as="orders" url="'https://example.invalid'" auto="false"/></head></stack>`,
  );
  const registry: Registry = {
    components: { "t.ApiDiet": ir }, globalPool: {}, css: "", schemes: [],
  };
  try {
    globals.__DSX_OPTIONAL_APIS__ = false;
    const stripped = instantiate(ir, registry);
    assert.equal(stripped.ctx.env.apis.size, 0, "an API-free embed does not retain the transport");
    stripped.unmount();

    globals.__DSX_OPTIONAL_APIS__ = true;
    const retained = instantiate(ir, registry);
    assert.equal(retained.ctx.env.apis.size, 1, "a slice declaring <api> retains normal behavior");
    retained.unmount();
  } finally {
    if (previous === undefined) delete globals.__DSX_OPTIONAL_APIS__;
    else globals.__DSX_OPTIONAL_APIS__ = previous;
  }
});

test("nested .dsx components inherit the router frame stamp for module calls", async () => {
  let received: unknown = null;
  ModuleRegistry.register({
    scheme: "nestedframeprobe",
    actions: {
      read: (ctx) => { received = ctx.args("__frame"); return null; },
    },
  });
  const child = compileComponent("FrameChild", "t",
    `<stack on:appear="dsx.module.nestedframeprobe.read({})"/>`);
  const parent = compileComponent("FrameParent", "t", `<stack><FrameChild/></stack>`);
  const registry: Registry = {
    components: { "t.FrameChild": child, "t.FrameParent": parent },
    globalPool: {}, css: "", schemes: [],
  };

  instantiate(parent, registry, { frameId: 321 });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(received, 321, "NavBar-like child actions target their owning routed surface");
});

// ── L-01 element-ledger closure ──────────────────────────────────────────────────
//  Each block below is the PROOF for one row that moved out of `partial` in
//  support/element-support.json. A row cannot claim `supported` without the
//  corresponding assertions here (and their SSR twins in
//  packages/server/test/render.test.ts).

test("<text markdown> renders the inline vocabulary the native AttributedString renders", () => {
  const md = mountOne("text", {
    markdown: "true",
    value: "{{ dsx.variable.copy }}",
  }, { copy: "Read the **docs**, run `dsx build`, see [more](https://dsx.dev/x)." });
  assert.equal(md.el.childCount, 7);
  assert.equal(md.el.childAt(1).tagName, "STRONG");
  assert.equal(md.el.childAt(1).childAt(0).textContent, "docs");
  assert.equal(md.el.childAt(3).tagName, "CODE");
  assert.equal(md.el.childAt(3).childAt(0).textContent, "dsx build");
  assert.equal(md.el.childAt(5).tagName, "A");
  assert.equal(md.el.childAt(5).getAttribute("href"), "https://dsx.dev/x");
  assert.equal(md.el.childAt(5).getAttribute("rel"), "noopener noreferrer");

  // A bound rewrite re-parses; markup in the DATA can never become markup in the DOM.
  md.store.set("copy", "<img src=x onerror=alert(1)> ~~gone~~");
  flushEffects();
  assert.equal(md.el.childAt(0).nodeType, 3, "hostile markup stays a TEXT node");
  assert.equal(md.el.childAt(0).textContent, "<img src=x onerror=alert(1)> ");
  assert.equal(md.el.childAt(1).tagName, "DEL");

  // A javascript: target is refused; the label degrades to plain text, never a link.
  md.store.set("copy", "[tap](javascript:alert(1))");
  flushEffects();
  assert.equal(md.el.childCount, 1);
  assert.equal(md.el.childAt(0).nodeType, 3);
  assert.equal(md.el.childAt(0).textContent, "[tap](javascript:alert(1))");
});

test("<text markdown> flips live, and an unmarked <text> stays a plain text write", () => {
  const t = mountOne("text", {
    markdown: "{{ dsx.variable.rich }}",
    value: "**bold**",
  }, { rich: false });
  assert.equal(t.el.textContent, "**bold**", "markdown off: the raw string, verbatim");
  t.store.set("rich", true);
  flushEffects();
  assert.equal(t.el.childAt(0).tagName, "STRONG");
  t.store.set("rich", false);
  flushEffects();
  assert.equal(t.el.textContent, "**bold**");

  const plain = mountOne("text", { value: "**bold**" });
  assert.equal(plain.el.textContent, "**bold**");
  assert.equal(plain.el.childCount, 0);
});

test("<text lineLimit> clamps to N lines and releases on a zero/absent value", () => {
  const clamped = mountOne("text", {
    value: "long copy",
    lineLimit: "{{ dsx.variable.n }}",
  }, { n: 2 });
  assert.equal(clamped.el.style.values.get("display"), "-webkit-box");
  assert.equal(clamped.el.style.values.get("-webkit-line-clamp"), "2");
  assert.equal(clamped.el.style.values.get("-webkit-box-orient"), "vertical");
  assert.equal(clamped.el.style.values.get("overflow"), "hidden");
  clamped.store.set("n", 0);
  flushEffects();
  assert.equal(clamped.el.style.values.get("-webkit-line-clamp"), undefined, "0 = no clamp, not a zero-height box");
  clamped.store.set("n", 10_000);
  flushEffects();
  assert.equal(clamped.el.style.values.get("-webkit-line-clamp"), "1000", "bounded against hostile counts");
});

test("<image> honors systemImage, fontSize, color, a11yLabel and the decorative default", () => {
  const decorative = mountOne("image", { icon: "star" });
  assert.equal(decorative.el.getAttribute("aria-hidden"), "true");
  assert.equal(decorative.el.getAttribute("role"), null);
  assert.equal(decorative.el.childAt(0).getAttribute("width"), "24", "iconSize default is the fixture's 24");

  const named = mountOne("image", {
    systemImage: "star",
    fontSize: "13",
    color: "destructive",
    a11yLabel: "{{ dsx.variable.label }}",
  }, { label: "Favourite" });
  assert.equal(named.el.getAttribute("role"), "img");
  assert.equal(named.el.getAttribute("aria-label"), "Favourite");
  assert.equal(named.el.getAttribute("aria-hidden"), null);
  assert.equal(named.el.childAt(0).getAttribute("width"), "13", "fontSize is the iconSize fallback");
  assert.equal(named.el.style.values.get("color"), "var(--dsx-destructive)");
  named.store.set("label", "Saved");
  flushEffects();
  assert.equal(named.el.getAttribute("aria-label"), "Saved");
});

test("<image> resolves asset paths, reports native bundle keys, and busts the cache on demand", () => {
  const path = mountOne("image", { asset: "media/logo.png", a11yLabel: "Logo" });
  assert.equal(path.el.getAttribute("data-dsx-unresolved"), null);
  assert.equal(path.el.value, "");
  assert.equal(path.el.alt, "Logo");
  assert.equal(path.el.src, "media/logo.png");

  const bundled = mountOne("image", { asset: "AppLogo", a11yLabel: "App logo" });
  assert.equal(bundled.el.getAttribute("data-dsx-unresolved"), "asset",
    "a native bundle key has no browser twin — reported, never a silent blank");
  assert.equal(bundled.el.alt, "App logo", "the accessible name survives the unresolved source");

  const cached = mountOne("image", { src: "/a.png" });
  assert.equal(cached.el.src, "/a.png", "the default rides the browser HTTP cache");
  const fresh = mountOne("image", { src: "/a.png?v=1", cache: "none" });
  assert.match(fresh.el.src, /^\/a\.png\?v=1&dsx-nc=/, "cache=none appends a per-mount bust key");
});

test("<textfield> maps keyboard= and contentType= to inputmode/type/autocomplete", () => {
  const email = mountOne("textfield", { keyboard: "email", contentType: "emailAddress" });
  assert.equal(email.el.type, "email");
  assert.equal(email.el.getAttribute("inputmode"), "email");
  assert.equal(email.el.getAttribute("autocomplete"), "email");

  const pin = mountOne("textfield", { keyboard: "number", contentType: "oneTimeCode" });
  assert.equal(pin.el.type, "text", "a numeric KEYBOARD is not a number INPUT (no spinner, no locale parse)");
  assert.equal(pin.el.getAttribute("inputmode"), "numeric");
  assert.equal(pin.el.getAttribute("autocomplete"), "one-time-code");

  const secret = mountOne("textfield", { secure: "true", keyboard: "email", contentType: "password" });
  assert.equal(secret.el.type, "password", "secure always wins the input type");
  assert.equal(secret.el.getAttribute("autocomplete"), "current-password");

  const unknown = mountOne("textfield", { keyboard: "constructor", contentType: "__proto__" });
  assert.equal(unknown.el.getAttribute("inputmode"), null, "prototype members are not tokens");
  assert.equal(unknown.el.getAttribute("autocomplete"), null);
  assert.equal(unknown.el.type, "text");
});

test("<searchbar> mounts the leading glass, the clear button and the on:clear contract", () => {
  const search = mountOne("searchbar", { bind: "dsx.variable.q" }, { q: "coffee" });
  assert.equal(search.el.className, "dsx-searchbar-field");
  assert.equal(search.el.getAttribute("data-dsx-component"), "search-field");
  const icon = search.el.childAt(0);
  assert.equal(icon.getAttribute("data-dsx-part"), "icon");
  assert.equal(icon.getAttribute("aria-hidden"), "true");
  const input = search.el.childAt(1);
  assert.equal(input.type, "search");
  assert.equal(input.placeholder, "Search", "the fixture placeholder default is Search");
  const clear = search.el.childAt(2);
  assert.equal(clear.getAttribute("aria-label"), "Clear search");
  assert.equal(clear.hidden, false, "a non-empty field shows the clear affordance");

  clear.click();
  assert.equal(search.store.getPath("q"), "", "clearing writes the bound path back");
  assert.equal(input.value, "");
  assert.equal(clear.hidden, true, "an empty field hides it again");
});

test("<textarea> grows between minLines and maxLines and never past it", () => {
  const area = mountOne("textarea", {
    bind: "dsx.variable.body",
    minLines: "2",
    maxLines: "4",
  }, { body: "" });
  assert.equal(area.el.rows, 2);
  assert.equal(area.el.style.values.get("--dsx-textarea-max-lines"), "4");
  area.store.set("body", "a\nb\nc");
  flushEffects();
  assert.equal(area.el.rows, 3, "the field grows with its content");
  area.store.set("body", "a\nb\nc\nd\ne\nf\ng");
  flushEffects();
  assert.equal(area.el.rows, 4, "maxLines is enforced — it scrolls from here");

  const reversed = mountOne("textarea", { minLines: "9", maxLines: "2" });
  assert.equal(reversed.el.rows, 2, "a reversed pair normalizes by swapping, never by trapping");
  const hostile = mountOne("textarea", { minLines: "-4", maxLines: "1e309" });
  assert.equal(hostile.el.rows, 1, "a negative count floors at one line");
  assert.equal(hostile.el.style.values.get("--dsx-textarea-max-lines"), "8",
    "a non-finite count falls back to the fixture default, never to layout");
  const huge = mountOne("textarea", { minLines: "1", maxLines: "9000" });
  assert.equal(huge.el.style.values.get("--dsx-textarea-max-lines"), "64", "enormous but finite counts clamp");
});

test("<stepper> press-and-hold repeats and accelerates, and releases cleanly", async () => {
  const s = mountOne("stepper", {
    bind: "dsx.variable.n", min: "0", max: "100", step: "1",
  }, { n: 0 });
  const plus = s.el.childAt(2);
  plus.dispatch("pointerdown");
  assert.equal(s.store.getPath("n"), 0, "the hold delay has not elapsed — no repeat yet");
  await new Promise((r) => setTimeout(r, 900));
  const held = Number(s.store.getPath("n"));
  assert.ok(held >= 2, `a held pointer repeats (saw ${held})`);
  plus.dispatch("pointerup");
  const settled = Number(s.store.getPath("n"));
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(Number(s.store.getPath("n")), settled, "release stops the repeat");
});

test("<Accordion> named header slot REPLACES the default title + chevron", () => {
  registerGlobalElements(UNIVERSAL_GLOBAL_ELEMENTS);
  const custom = mountTree(xml("Accordion", { title: "Ignored", open: "true" }, [
    xml("text", { slot: "header", value: "Custom header" }),
    xml("text", { value: "Body copy" }),
  ]));
  const header = custom.el.childAt(0);
  assert.equal(header.getAttribute("data-dsx-part"), "header");
  assert.equal(header.childCount, 1, "the default title + chevron are gone, not stacked with the slot");
  assert.equal(header.childAt(0).textContent, "Custom header");
  const body = custom.el.childAt(1);
  assert.ok(body.classList.contains("dsx-accordion-body"));
  assert.equal(body.childCount, 1, "the header child does NOT leak into the collapsible body");
  assert.equal(body.childAt(0).textContent, "Body copy");

  const standard = mountTree(xml("Accordion", { title: "Details" }, [xml("text", { value: "Body" })]));
  assert.equal(standard.el.childAt(0).getAttribute("data-dsx-part"), null);
  assert.equal(standard.el.childAt(0).childAt(0).textContent, "Details");
  assert.equal(standard.el.childAt(0).childAt(1).getAttribute("aria-hidden"), "true", "the default chevron survives");
});

test("<Table> renders the whole native contract: header traits, one-element rows, bounded input", () => {
  registerDataControls();
  registerGlobalElements(DATA_CONTROL_GLOBAL_ELEMENTS);
  const t = mountOne("Table", {
    bind: "dsx.variable.orders",
    columns: "Item,Qty,Total",
    fields: "name,qty,total",
    color: "destructive",
  }, { orders: [{ name: "Espresso", qty: 2, total: "$7.00" }, { name: "Bun", qty: 1, total: "$3.50" }] });
  assert.equal(t.el.getAttribute("role"), "region");
  assert.equal(t.el.style.values.get("--dsx-table-color"), "var(--dsx-destructive)");
  const table = t.el.childAt(0);
  const head = table.childAt(0);
  const body = table.childAt(1);
  assert.equal(head.childAt(0).childCount, 3);
  assert.equal(head.childAt(0).childAt(0).scope, "col", "header cells carry the header trait");
  assert.equal(head.childAt(0).childAt(2).textContent, "Total");
  assert.equal(body.childCount, 2);
  // Table.swift combines each row into ONE accessibility element ("Espresso, 2, $7.00").
  assert.equal(body.childAt(0).getAttribute("aria-label"), "Espresso, 2, $7.00");
  assert.equal(body.childAt(0).childAt(1).textContent, "2");
  assert.equal(table.getAttribute("aria-rowcount"), "3");
  assert.equal(table.getAttribute("aria-colcount"), "3");
  assert.equal(t.el.getAttribute("data-dsx-truncated"), "false");

  // fields omitted → the lowercased column labels (Table.swift:26)
  const implied = mountOne("Table", {
    bind: "dsx.variable.rows", columns: "Name,Qty",
  }, { rows: [{ name: "Tea", qty: 4 }] });
  assert.equal(implied.el.childAt(0).childAt(1).childAt(0).getAttribute("aria-label"), "Tea, 4");

  // the explicit safety ceiling: rows past the cap are dropped and the frame says so
  const huge = mountOne("Table", {
    bind: "dsx.variable.rows", columns: "N",
  }, { rows: Array.from({ length: DATA_CONTROL_LIMITS.tableRows + 5 }, (_, i) => ({ n: i })) });
  assert.equal(huge.el.childAt(0).childAt(1).childCount, DATA_CONTROL_LIMITS.tableRows);
  assert.equal(huge.el.getAttribute("data-dsx-truncated"), "true");
});
