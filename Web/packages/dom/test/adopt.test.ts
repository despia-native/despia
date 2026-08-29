//
//  adopt.test.ts — the adopt-hydration walk (W6 slice 1, adopt.ts) against REAL
//  server output: renderToString({hydrate}) HTML is parsed into a DOM stand-in and
//  instantiate({adopt}) binds it. Pinned here:
//    • identity preservation — the ADOPT tier reuses the server elements (same
//      objects), bindings and handlers land on them, and post-adopt store writes
//      update them in place;
//    • the REBUILD tier — control machinery (toggle) is claimed (structure
//      verified) then factory-rebuilt in place, counted, never a mismatch;
//    • visible-if — an initially-true branch adopts and still toggles live; an
//      initially-false branch mounts later exactly like a fresh mount;
//    • fail-open mismatch handling — a missing/mis-stamped/extra server element
//      counts, warns once, and replace-mounts that subtree; content never blanks.
//
//  node --test runs this file in its own process; the DOM stand-in below is richer
//  than mount.test.ts's because the walk traverses siblings, inserts at cursors,
//  and swaps subtrees.
//

import { test } from "node:test";
import assert from "node:assert/strict";

import { ReactiveStore, ActionRunner, makeRunEnv, flushEffects } from "@despia-native/kernel";
import { compileComponent } from "@despia-native/compiler/component";
import { CssCollector, extractComponentCss } from "../../compiler/src/css.ts";
import type { Registry } from "@despia-native/compiler/resolve";

// ── the DOM stand-in ─────────────────────────────────────────────────────────────────

class FakeNode {
  nodeType = 0;
  parent: FakeElement | null = null;
  get parentNode(): FakeElement | null { return this.parent; }
  get nextSibling(): FakeNode | null {
    if (this.parent === null) return null;
    const i = this.parent.kids.indexOf(this);
    return i < 0 ? null : this.parent.kids[i + 1] ?? null;
  }
  get previousSibling(): FakeNode | null {
    if (this.parent === null) return null;
    const i = this.parent.kids.indexOf(this);
    return i <= 0 ? null : this.parent.kids[i - 1] ?? null;
  }
  get isConnected(): boolean {
    let cur: FakeNode = this;
    while (cur.parent !== null) cur = cur.parent;
    return (cur as FakeElement).connectedRoot === true;
  }
  remove(): void {
    if (this.parent !== null) this.parent.kids = this.parent.kids.filter((k) => k !== this);
    this.parent = null;
  }
  after(...nodes: FakeNode[]): void {
    const parent = this.parent;
    if (parent === null) return;
    let anchor: FakeNode = this;
    for (const n of nodes) {
      parent.insertBefore(n, anchor.nextSibling);
      anchor = n;
    }
  }
  replaceWith(...nodes: FakeNode[]): void {
    const parent = this.parent;
    if (parent === null) return;
    for (const n of nodes) parent.insertBefore(n, this);
    this.remove();
  }
}

class FakeText extends FakeNode {
  data: string;
  constructor(data: string) { super(); this.nodeType = 3; this.data = data; }
  get textContent(): string { return this.data; }
  set textContent(v: string) { this.data = v; }
}

class FakeComment extends FakeNode {
  data: string;
  constructor(data: string) { super(); this.nodeType = 8; this.data = data; }
  get textContent(): string { return this.data; }
}

class FakeClassList {
  private owner: FakeElement;
  constructor(owner: FakeElement) { this.owner = owner; }
  private read(): Set<string> {
    return new Set((this.owner.getAttribute("class") ?? "").split(/\s+/).filter((c) => c.length > 0));
  }
  private write(s: Set<string>): void { this.owner.setAttribute("class", [...s].join(" ")); }
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

class FakeElement extends FakeNode {
  tagName: string;
  kids: FakeNode[] = [];
  connectedRoot = false;
  value = "";
  type = "";
  tabIndex = 0;
  checked = false;
  disabled = false;
  hidden = false;
  inert = false;
  scrollLeft = 0; scrollTop = 0; scrollWidth = 0; scrollHeight = 0;
  clientWidth = 640; clientHeight = 480;
  readonly classList = new FakeClassList(this);
  readonly style = {
    values: new Map<string, string>(),
    touchAction: "", userSelect: "",
    setProperty(k: string, v: string): void { this.values.set(k, v); },
    removeProperty(k: string): void { this.values.delete(k); },
  };
  readonly dataset: { [key: string]: string } = {};
  private attrs = new Map<string, string>();
  private listeners = new Map<string, Array<(event: FakeEvent) => void>>();
  constructor(tag: string) { super(); this.nodeType = tag === "#fragment" ? 11 : 1; this.tagName = tag.toUpperCase(); }
  get className(): string { return this.getAttribute("class") ?? ""; }
  set className(v: string) { this.setAttribute("class", v); }
  setAttribute(k: string, v: string): void { this.attrs.set(k, v); }
  getAttribute(k: string): string | null { return this.attrs.get(k) ?? null; }
  hasAttribute(k: string): boolean { return this.attrs.has(k); }
  removeAttribute(k: string): void { this.attrs.delete(k); }
  appendChild<T extends FakeNode>(c: T): T { this.insertBefore(c, null); return c; }
  append(...cs: FakeNode[]): void { for (const c of cs) this.appendChild(c); }
  prepend(c: FakeNode): void { this.insertBefore(c, this.kids[0] ?? null); }
  insertBefore<T extends FakeNode>(node: T, ref: FakeNode | null): T {
    if (node.nodeType === 11) {
      for (const child of [...(node as unknown as FakeElement).kids]) this.insertBefore(child, ref);
      return node;
    }
    node.remove();
    node.parent = this;
    const i = ref === null ? this.kids.length : this.kids.indexOf(ref);
    this.kids.splice(i < 0 ? this.kids.length : i, 0, node);
    return node;
  }
  replaceChildren(...cs: FakeNode[]): void {
    for (const child of this.kids) child.parent = null;
    this.kids = [];
    this.append(...cs);
  }
  get childNodes(): FakeNode[] { return [...this.kids]; }
  get firstChild(): FakeNode | null { return this.kids[0] ?? null; }
  get lastChild(): FakeNode | null { return this.kids[this.kids.length - 1] ?? null; }
  get firstElementChild(): FakeElement | null {
    return (this.kids.find((k) => k.nodeType === 1) as FakeElement | undefined) ?? null;
  }
  get nextElementSibling(): FakeElement | null {
    let cur = this.nextSibling;
    while (cur !== null && cur.nodeType !== 1) cur = cur.nextSibling;
    return cur as FakeElement | null;
  }
  get children(): FakeElement[] { return this.kids.filter((k) => k.nodeType === 1) as FakeElement[]; }
  get textContent(): string {
    return this.kids
      .map((k) => (k.nodeType === 1 || k.nodeType === 3 ? (k as FakeElement | FakeText).textContent : ""))
      .join("");
  }
  set textContent(v: string) {
    this.replaceChildren();
    if (v.length > 0) this.appendChild(new FakeText(v));
  }
  contains(target: FakeNode): boolean {
    if (this === target) return true;
    return this.kids.some((k) => k === target || (k.nodeType === 1 && (k as FakeElement).contains(target)));
  }
  closest(): null { return null; }
  querySelector(): null { return null; }
  addEventListener(type: string, listener: (event: FakeEvent) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }
  removeEventListener(): void {}
  dispatch(type: string): FakeEvent {
    const event = new FakeEvent(type);
    for (const l of this.listeners.get(type) ?? []) l(event);
    return event;
  }
  click(): void {
    if (this.disabled) return;
    this.dispatch("click");
  }
  focus(): void { fakeDocument.activeElement = this; }
  getBoundingClientRect(): { width: number; height: number; left: number; top: number } {
    return { width: this.clientWidth, height: this.clientHeight, left: 0, top: 0 };
  }
  /** test helper: find by predicate, depth-first */
  find(predicate: (el: FakeElement) => boolean): FakeElement | null {
    for (const k of this.kids) {
      if (k.nodeType !== 1) continue;
      const el = k as FakeElement;
      if (predicate(el)) return el;
      const inner = el.find(predicate);
      if (inner !== null) return inner;
    }
    return null;
  }
}

class FakeEvent {
  defaultPrevented = false;
  readonly type: string;
  readonly key: string;
  constructor(type: string, key = "") { this.type = type; this.key = key; }
  preventDefault(): void { this.defaultPrevented = true; }
  stopPropagation(): void {}
  stopImmediatePropagation(): void {}
}

const fakeDocument = {
  baseURI: "https://demo.example/",
  activeElement: null as FakeElement | null,
  createElement: (t: string) => new FakeElement(t),
  createElementNS: (_ns: string, t: string) => new FakeElement(t),
  createComment: (t: string) => new FakeComment(t),
  createDocumentFragment: () => new FakeElement("#fragment"),
  addEventListener: (): void => {},
  removeEventListener: (): void => {},
};
(globalThis as { document?: unknown }).document = fakeDocument;
(globalThis as { HTMLAnchorElement?: unknown }).HTMLAnchorElement = FakeElement;
(globalThis as { HTMLButtonElement?: unknown }).HTMLButtonElement = FakeElement;
(globalThis as { window?: unknown }).window = {
  addEventListener: (): void => {},
  removeEventListener: (): void => {},
};

// AFTER the DOM stand-in exists: mount/adopt read `document` at call time, but the
// imports must not observe a half-built global.
const { instantiate } = await import("../src/mount.ts");
const { hydrationReport, resetHydrationReport } = await import("../src/adopt.ts");
const { renderToString } = await import("../../server/src/render.ts");

// ── a parser for the emitter's own HTML subset (tags, quoted attrs, entities) ───────

const VOID_TAGS = new Set(["IMG", "INPUT", "BR", "HR", "META", "LINK"]);

function decodeEntities(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|#39);/g, (_, name: string) =>
    name === "amp" ? "&" : name === "lt" ? "<" : name === "gt" ? ">" : name === "quot" ? '"' : "'");
}

function parseHtml(html: string): FakeElement {
  const host = new FakeElement("div");
  host.connectedRoot = true;
  const stack: FakeElement[] = [host];
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0 || lt > i) {
      const text = html.substring(i, lt < 0 ? html.length : lt);
      if (text.length > 0) stack[stack.length - 1]!.appendChild(new FakeText(decodeEntities(text)));
      if (lt < 0) break;
      i = lt;
    }
    if (html[i + 1] === "/") {
      const gt = html.indexOf(">", i);
      stack.pop();
      i = gt + 1;
      continue;
    }
    const gt = html.indexOf(">", i);
    const raw = html.substring(i + 1, gt);
    const space = raw.search(/[\s/]/);
    const tag = (space < 0 ? raw : raw.substring(0, space)).toUpperCase();
    const el = new FakeElement(tag);
    const attrText = space < 0 ? "" : raw.substring(space);
    for (const m of attrText.matchAll(/([A-Za-z0-9:_-]+)(?:="([^"]*)")?/g)) {
      el.setAttribute(m[1]!, decodeEntities(m[2] ?? ""));
    }
    stack[stack.length - 1]!.appendChild(el);
    if (!VOID_TAGS.has(tag) && !raw.endsWith("/")) stack.push(el);
    i = gt + 1;
  }
  return host;
}

// ── harness ──────────────────────────────────────────────────────────────────────────

function registryOf(sources: { [qualified: string]: string }): Registry {
  const components: Registry["components"] = {};
  const collector = new CssCollector();
  for (const [qualified, markup] of Object.entries(sources)) {
    const scheme = qualified.substring(0, qualified.indexOf("."));
    const name = qualified.substring(qualified.indexOf(".") + 1);
    const ir = compileComponent(name, scheme, markup);
    extractComponentCss(ir, collector);
    components[qualified] = ir;
  }
  return { components, globalPool: {}, css: collector.emit(), schemes: [] };
}

function drain(): Promise<void> {
  return new Promise((resolveDrain) => setImmediate(() => { flushEffects(); resolveDrain(); }));
}

/** server-render with stamps, parse, adopt; returns the host + instance + server root */
function adoptOf(registry: Registry, qualified: string) {
  const html = renderToString(registry, qualified, {}, { hydrate: true });
  const host = parseHtml(html);
  const serverRoot = host.firstElementChild!;
  resetHydrationReport();
  const instance = instantiate(registry.components[qualified]!, registry, {
    adopt: serverRoot as unknown as Element,
  });
  return { html, host, serverRoot, instance };
}

const APP = registryOf({
  "t.Card": `<stack class="card"><text value="card:"/><slot/></stack>`,
  "t.Screen": `<stack>
    <head>
      <variable as="label">return 'first'</variable>
      <variable as="show">return true</variable>
      <variable as="hideMe">return false</variable>
      <variable as="on">return true</variable>
    </head>
    <text value="{{ label }}"/>
    <button label="go" on:tap="label = 'tapped'"/>
    <stack visible-if="show"><text value="branch"/></stack>
    <text visible-if="hideMe" value="hidden-at-boot"/>
    <toggle bind="on"/>
    <t.Card><text value="slotted"/></t.Card>
  </stack>`,
});

// A reactive shell wrapping a large INERT subtree — the islands fixture (doc 02).
// The whole `inert` block has no binding/handler/visible-if/component anywhere, so
// the compiler stamps its subtree reactive===false and the adopt walk skips it.
const ISLANDS = registryOf({
  "t.Islands": `<stack>
    <head><variable as="live">return 'shell'</variable></head>
    <text value="{{ live }}"/>
    <stack class="inert">
      <text value="alpha"/>
      <stack class="deep"><text value="beta"/><image src="/pic.png"/><divider/></stack>
      <spacer/>
    </stack>
  </stack>`,
  // identical reactive shell, BIGGER inert block — the differential proof that inert
  // content adds ZERO reactive graph (disposer count must not grow with it)
  "t.IslandsBigger": `<stack>
    <head><variable as="live">return 'shell'</variable></head>
    <text value="{{ live }}"/>
    <stack class="inert">
      <text value="alpha"/>
      <stack class="deep"><text value="beta"/><image src="/pic.png"/><divider/></stack>
      <stack class="deep2"><text value="gamma"/><text value="delta"/><text value="epsilon"/><divider/></stack>
      <stack class="deep3"><text value="zeta"/><image src="/q.png"/><spacer/></stack>
      <spacer/>
    </stack>
  </stack>`,
});

// ── the tests ────────────────────────────────────────────────────────────────────────

test("adopt: zero mismatches on in-sync server output; identity is preserved", () => {
  const { host, serverRoot, instance } = adoptOf(APP, "t.Screen");
  const report = hydrationReport();
  assert.equal(report.mismatches, 0, "in-sync page must adopt with mismatch = 0");
  assert.equal(report.mode, "adopted");
  assert.ok(report.adopted >= 6, `structural tier adopted in place (got ${report.adopted})`);
  assert.ok(report.rebuilt >= 1, "the toggle is machinery: claimed then rebuilt");
  // AUTOMATIC ISLANDS: the inert leaves (branch text, the card's static text, the
  // caller's slotted text) were skipped — reused, not re-instantiated.
  assert.ok(report.islandsSkipped >= 3, `inert leaves skipped as islands (got ${report.islandsSkipped})`);
  // THE identity claim: the instance root IS the server element, not a recreation
  assert.equal(instance.root as unknown, serverRoot);
  const text = host.find((el) => el.getAttribute("data-dsx-n") === "1");
  assert.ok(text !== null && text.textContent === "first", "adopted text kept its server content");
  instance.unmount();
});

test("adopt: an inert subtree is SKIPPED — DOM reused, no reactive graph built", () => {
  const { host, serverRoot, instance } = adoptOf(ISLANDS, "t.Islands");
  const report = hydrationReport();
  assert.equal(report.mismatches, 0, "islands never diverge on in-sync output");
  // the whole `class="inert"` block is one island: claimed by identity, walked no further
  assert.ok(report.islandsSkipped >= 1, `the inert block was skipped (got ${report.islandsSkipped})`);
  // ONLY the reactive shell was adopted (root stack + the {{ live }} text = 2). The
  // five inert elements under `inert` got NO ElementApi and NO binding — otherwise
  // adopted would exceed 2. That, with the reuse proof below, is "no reactive graph".
  assert.equal(report.adopted, 2, `only the reactive shell adopts (got ${report.adopted})`);

  // reuse: the deep inert element is the SAME object the server emitted (parsed once
  // into `serverRoot`), still connected, still carrying its server content
  const deepBeta = serverRoot.find((el) => el.tagName === "SPAN" && el.textContent === "beta");
  assert.ok(deepBeta !== null, "the deep inert text is present");
  assert.ok(deepBeta!.isConnected, "…still connected (reused in place, not replaced)");
  const stillThere = host.find((el) => el.tagName === "SPAN" && el.textContent === "beta");
  assert.equal(stillThere as unknown, deepBeta as unknown, "the live tree holds the SAME element object");

  instance.unmount();
});

test("adopt: inert content contributes ZERO reactive graph (disposer differential)", () => {
  // Identical reactive shell, very different inert payload. If any inert node built a
  // binding/effect, the bigger payload's disposer set would grow. It must not.
  const small = adoptOf(ISLANDS, "t.Islands");
  const big = adoptOf(ISLANDS, "t.IslandsBigger");
  assert.equal(hydrationReport().mismatches, 0);
  const smallDisposers = small.instance.ctx.disposers.length;
  const bigDisposers = big.instance.ctx.disposers.length;
  assert.equal(
    bigDisposers, smallDisposers,
    `inert content built no reactive graph: disposers equal (${smallDisposers} vs ${bigDisposers})`,
  );
  small.instance.unmount();
  big.instance.unmount();
});

test("adopt: bindings and handlers are LIVE on the adopted elements", async () => {
  const { host, instance } = adoptOf(APP, "t.Screen");
  const text = host.find((el) => el.getAttribute("data-dsx-n") === "1")!;
  const sameTextEl = text; // identity handle before updates
  instance.ctx.store.set("label", "second");
  await drain();
  assert.equal(sameTextEl.textContent, "second", "the store write updated the SAME element in place");
  // the adopted button carries a working on:tap
  const button = host.find((el) => el.tagName === "BUTTON" && el.getAttribute("data-dsx-n") === "2")!;
  button.click();
  await drain();
  await drain(); // runner completion + effect flush
  assert.equal(sameTextEl.textContent, "tapped", "the adopted button's handler ran against the store");
  instance.unmount();
});

test("adopt: visible-if branches toggle live after adoption, both directions", async () => {
  const { host, instance } = adoptOf(APP, "t.Screen");
  const branchText = (): FakeElement | null => host.find((el) => el.textContent === "branch" && el.tagName === "SPAN");
  assert.ok(branchText() !== null, "initially-true branch was adopted");
  instance.ctx.store.set("show", false);
  await drain();
  assert.equal(branchText(), null, "toggle-off removed the adopted branch");
  instance.ctx.store.set("show", true);
  await drain();
  assert.ok(branchText() !== null, "toggle-on remounted it fresh");
  // the initially-false branch mounts later like any fresh mount
  assert.equal(host.find((el) => el.textContent === "hidden-at-boot"), null);
  instance.ctx.store.set("hideMe", true);
  await drain();
  assert.ok(host.find((el) => el.textContent === "hidden-at-boot") !== null);
  instance.unmount();
});

test("adopt: nested component + caller-scope slot content adopt through the owner stamp", () => {
  const { host } = adoptOf(APP, "t.Screen");
  const report = hydrationReport();
  assert.equal(report.mismatches, 0);
  const card = host.find((el) => el.getAttribute("data-dsx-owner") === "Card");
  assert.ok(card !== null, "the child component root was claimed by owner");
  assert.ok(card!.textContent.includes("card:"), "child content adopted");
  assert.ok(card!.textContent.includes("slotted"), "slot content (caller scope) adopted inline");
});

test("adopt: a missing server element is ONE counted mismatch and fail-open fresh content", () => {
  const html = renderToString(APP, "t.Screen", {}, { hydrate: true });
  const host = parseHtml(html);
  const serverRoot = host.firstElementChild!;
  // sabotage: delete the first text element the walk will look for
  serverRoot.find((el) => el.getAttribute("data-dsx-n") === "1")!.remove();
  resetHydrationReport();
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
  try {
    instantiate(APP.components["t.Screen"]!, APP, { adopt: serverRoot as unknown as Element });
  } finally {
    console.warn = originalWarn;
  }
  const report = hydrationReport();
  assert.ok(report.mismatches >= 1, "the divergence is counted");
  assert.ok(warnings.some((w) => w.includes("[dsx hydrate]")), "one diagnostic names the site");
  const text = host.find((el) => el.textContent === "first");
  assert.ok(text !== null, "fail-open: the subtree was replace-mounted, never blank");
});

test("adopt: leftover server elements are counted, warned once, and removed", () => {
  const html = renderToString(APP, "t.Screen", {}, { hydrate: true });
  const host = parseHtml(html);
  const serverRoot = host.firstElementChild!;
  const stray = new FakeElement("div");
  stray.setAttribute("data-dsx-n", "999");
  stray.textContent = "junk the server should not have sent";
  serverRoot.appendChild(stray);
  resetHydrationReport();
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    instantiate(APP.components["t.Screen"]!, APP, { adopt: serverRoot as unknown as Element });
  } finally {
    console.warn = originalWarn;
  }
  const report = hydrationReport();
  assert.ok(report.mismatches >= 1, "leftovers are a divergence");
  assert.ok(report.discarded >= 1, "and they are removed");
  assert.equal(serverRoot.contains(stray), false, "the stray element is gone");
});

test("adopt: machinery rebuild keeps the DOM shape without counting a mismatch", () => {
  const { host } = adoptOf(APP, "t.Screen");
  const report = hydrationReport();
  const toggle = host.find((el) => el.tagName === "LABEL" && (el.getAttribute("class") ?? "").includes("dsx-toggle"));
  assert.ok(toggle !== null, "the toggle exists after rebuild");
  const input = toggle!.find((el) => el.tagName === "INPUT");
  assert.ok(input !== null && input.checked, "the rebuilt control carries the bound state");
  assert.equal(report.mismatches, 0, "a documented rebuild is not a mismatch");
});

test("adopt: fresh-mount parity — the adopted tree matches what a fresh mount builds", () => {
  // the drift guard: whatever mount.ts would BUILD, adopt.ts must ACCEPT + produce
  const { host } = adoptOf(APP, "t.Screen");
  const fresh = instantiate(APP.components["t.Screen"]!, APP, {});
  const shape = (el: FakeElement): string => {
    const kids = el.children.map(shape).join(",");
    return `${el.tagName}(${kids})`;
  };
  assert.equal(
    shape(host.firstElementChild!),
    shape(fresh.root as unknown as FakeElement),
    "adopted element tree and fresh-mounted tree agree tag-for-tag",
  );
});

// An interpolated attribute on a component invocation, feeding a `visible-if` inside that
// component. Found by the v4 dashboard's own section labels: `count="{{ … }}"` used to be
// seeded as "" until an effect ran, so the component's FIRST pass decided from a value it
// had never been given. A fresh mount hid it (the effect corrected a tick later); adopt
// could not, because that first pass is what claims the server's element.
const ATTR_VIF = registryOf({
  "t.Label": `<hstack>
     <head><attribute as="title"/><attribute as="count" default="''"/></head>
     <text value="{{ dsx.attribute.title }}"/>
     <text visible-if="dsx.attribute.count !== ''" value="{{ dsx.attribute.count }}"/>
   </hstack>`,
  "t.Labels": `<stack>
     <head><variable as="n">return 0</variable></head>
     <t.Label title="Config"/>
     <t.Label title="Packages" count="{{ dsx.variable.n }}"/>
   </stack>`,
});

test("adopt: an interpolated attribute is seeded before the component's first pass", () => {
  const { serverRoot } = adoptOf(ATTR_VIF, "t.Labels");
  const report = hydrationReport();
  assert.equal(report.mismatches, 0, "the count branch must adopt, not replace-mount");
  assert.equal(report.discarded, 0, "no server element is left unmatched");
  // and the value is the real one, not the "" the seed used to be
  const labels = [...(serverRoot as unknown as { children: Iterable<Element> }).children];
  assert.equal(labels.length, 2);
  assert.equal([...labels[1]!.children].length, 2, "the count element is present");
  assert.equal([...labels[0]!.children].length, 1, "and absent where no count was passed");
});

test("adopt: a count of 0 is a value, not an absence — the seed does not coerce it away", async () => {
  const { serverRoot, instance } = adoptOf(ATTR_VIF, "t.Labels");
  const text = () => [...[...(serverRoot as unknown as { children: Iterable<Element> }).children][1]!.children]
    .map((c) => c.textContent).join("|");
  assert.equal(text(), "Packages|0");
  instance.ctx.store.set("n", 12);
  await drain();
  assert.equal(text(), "Packages|12", "the reactive effect still owns every later change");
});
