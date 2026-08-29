//
//  dynamic-node-and-surface-tags.test.ts — Wave 3 (b)1 + (b)2 (design-system.md):
//
//  <node>/<dynamic> — the data-driven tag resolves its `tag=` indirection BEFORE
//  factory lookup (Stack.swift `case "node","dynamic"` / StackNodeView.kt twins):
//  a resolved known tag mounts that element/component with this node's own attrs and
//  children; a bare <node> (or an expression resolving to nothing) renders its
//  children; an UNKNOWN resolved tag renders NOTHING — the capability boundary stays
//  silent, never the `<x>?` unsupported box a literal unknown tag earns.
//
//  <DSXWebView/> / <DSXView/> — the surface tags stop hitting the unresolved-component
//  warning and mount their honest web mappings: the app web surface rides the same
//  policy-constrained iframe as <WebView> at the page's own origin, and DSXView
//  resolves the screen `src` names from THIS build's compiled registry (the
//  router-painted-frame analogue), with the stable `dsx-view` lifecycle events.
//

import { test } from "node:test";
import assert from "node:assert/strict";

import { ReactiveStore, ActionRunner, makeRunEnv, flushEffects, DSXEvents } from "@despia/kernel";
import type { XmlNode } from "@despia/compiler/xml";
import type { Registry } from "@despia/compiler/resolve";
import { compileComponent } from "@despia/compiler/component";
import { mountNode, type MountCtx } from "../src/mount.ts";
import { registerRichElements, webSurfaceRegistry } from "../src/elements.ts";

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

class FakeEvent {
  defaultPrevented = false;
  readonly type: string;
  readonly key: string;
  constructor(type: string, key = "") { this.type = type; this.key = key; }
  preventDefault(): void { this.defaultPrevented = true; }
  stopPropagation(): void {}
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
  title = "";
  loading = "";
  referrerPolicy = "";
  placeholder = "";
  rows = 0;
  tabIndex = 0;
  hidden = false;
  inert = false;
  checked = false;
  disabled = false;
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
  kids: FakeElement[] = [];
  parent: FakeElement | null = null;
  private listeners = new Map<string, Array<(event: FakeEvent) => void>>();
  constructor(tag: string) { this.tagName = tag.toUpperCase(); }
  setAttribute(k: string, v: string): void { this.attrs.set(k, v); }
  getAttribute(k: string): string | null { return this.attrs.get(k) ?? null; }
  removeAttribute(k: string): void { this.attrs.delete(k); }
  appendChild(c: FakeElement): FakeElement {
    c.remove();
    c.parent = this;
    this.kids.push(c);
    return c;
  }
  append(...cs: FakeElement[]): void { for (const c of cs) this.appendChild(c); }
  prepend(c: FakeElement): void {
    c.remove();
    c.parent = this;
    this.kids.unshift(c);
  }
  replaceChildren(...cs: FakeElement[]): void {
    for (const child of this.kids) child.parent = null;
    this.kids = [];
    this.append(...cs);
  }
  after(...nodes: FakeElement[]): void {
    const host = this.parent;
    if (host === null) return;
    for (const n of nodes) n.remove();
    const index = host.kids.indexOf(this);
    host.kids.splice(index + 1, 0, ...nodes);
    for (const n of nodes) n.parent = host;
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
  removeEventListener(): void {}
  dispatch(type: string): FakeEvent {
    const event = new FakeEvent(type);
    for (const listener of this.listeners.get(type) ?? []) listener(event);
    return event;
  }
  focus(): void {}
  getBoundingClientRect(): DOMRect {
    return { width: this.clientWidth, height: this.clientHeight } as DOMRect;
  }
  get childNodes(): FakeElement[] { return [...this.kids]; }
  get firstElementChild(): FakeElement | null { return this.kids[0] ?? null; }
  get firstChild(): FakeElement | null { return this.kids[0] ?? null; }
  get nextSibling(): FakeElement | null {
    if (this.parent === null) return null;
    const index = this.parent.kids.indexOf(this);
    return index < 0 ? null : this.parent.kids[index + 1] ?? null;
  }
  childAt(i: number): FakeElement {
    const c = this.elementKids[i];
    if (c === undefined) throw new Error(`no element child at ${i}`);
    return c;
  }
  /** element children only — comment anchors (dsx:node / dsx:if) excluded */
  get elementKids(): FakeElement[] {
    return this.kids.filter((c) => !c.tagName.startsWith("#COMMENT"));
  }
  find(predicate: (el: FakeElement) => boolean): FakeElement | null {
    if (predicate(this)) return this;
    for (const kid of this.kids) { const hit = kid.find(predicate); if (hit !== null) return hit; }
    return null;
  }
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
  createComment: (t: string) => {
    const node = new FakeElement(`#comment:${t}`);
    node.nodeType = 8;
    return node;
  },
  createDocumentFragment: () => new FakeElement("#fragment"),
};
(globalThis as { document?: unknown }).document = fakeDocument;
(globalThis as { HTMLAnchorElement?: unknown }).HTMLAnchorElement = FakeElement;
(globalThis as { window?: unknown }).window = {
  addEventListener: (): void => {},
  removeEventListener: (): void => {},
};

registerRichElements();

function xml(tag: string, attrs: Record<string, string> = {}, children: XmlNode[] = []): XmlNode {
  return { tag, attrs, children, text: "" };
}

function mountTree(
  node: XmlNode,
  seed: { [k: string]: unknown } = {},
  components: { [qualified: string]: ReturnType<typeof compileComponent> } = {},
): { parent: FakeElement; store: ReactiveStore; ctx: MountCtx } {
  const store = new ReactiveStore();
  for (const [key, value] of Object.entries(seed)) store.set(key, value);
  const env = makeRunEnv(store);
  const registry: Registry = { components, globalPool: {}, css: "", schemes: [] };
  const ctx: MountCtx = {
    registry, scheme: "t", owner: "Test", store, runner: new ActionRunner(env), env,
    item: null, disposers: [], slots: null, rowBinding: null,
  };
  const parent = new FakeElement("div");
  mountNode(node, ctx, parent as unknown as ParentNode);
  return { parent, store, ctx };
}

function withWarnSpy<T>(run: () => T): { result: T; warnings: string[] } {
  const previous = console.warn;
  const warnings: string[] = [];
  console.warn = (...args: unknown[]): void => { warnings.push(args.map(String).join(" ")); };
  try { return { result: run(), warnings }; } finally { console.warn = previous; }
}

// ── <node>/<dynamic>: the tag= indirection resolves before factory lookup ──────────

test("<node tag> mounts the resolved builtin element with this node's own attributes", () => {
  const { parent } = mountTree(xml("node", { tag: "button", label: "Save" }));
  const button = parent.childAt(0);
  assert.equal(button.getAttribute("data-dsx-component"), "button");
  assert.ok(button.find((el) => el.textContent === "Save") !== null, "the label rides through");
});

test("<dynamic> is the exact alias of <node>", () => {
  const { parent } = mountTree(xml("dynamic", { tag: "text", value: "hello" }));
  const text = parent.childAt(0);
  assert.ok(text.classList.contains("dsx-text"));
  assert.ok(text.find((el) => el.textContent === "hello") !== null);
});

test("a bare <node> renders its children (the fall-through)", () => {
  const { parent } = mountTree(
    xml("node", {}, [xml("text", { value: "first" }), xml("text", { value: "second" })]),
  );
  assert.equal(parent.elementKids.length, 2);
  assert.ok(parent.find((el) => el.textContent === "first") !== null);
  assert.ok(parent.find((el) => el.textContent === "second") !== null);
});

test("an unknown resolved tag renders NOTHING — silent, never the unsupported box", () => {
  const lower = withWarnSpy(() =>
    mountTree(xml("node", { tag: "notatag" }, [xml("text", { value: "never" })])));
  assert.equal(lower.result.parent.elementKids.length, 0, "no unsupported box, and no children fallback");
  assert.equal(lower.result.parent.find((el) => el.classList.contains("dsx-unsupported")), null);
  const upper = withWarnSpy(() => mountTree(xml("node", { tag: "NotAComponent" })));
  assert.equal(upper.result.parent.elementKids.length, 0);
  assert.deepEqual(upper.warnings, [], "no unresolved-component warning for a dynamic miss");
});

test("a LITERAL unknown lowercase tag still earns the labelled unsupported box", () => {
  const { parent } = mountTree(xml("notatag", {}));
  const box = parent.childAt(0);
  assert.ok(box.classList.contains("dsx-unsupported"), "the literal-tag contract is unchanged");
});

test("<node tag> resolves a compiled component through the same lookup as a literal reference", () => {
  const card = compileComponent("Card", "t", `<stack><text value="card-body"/></stack>`);
  const { parent } = mountTree(xml("node", { tag: "Card" }), {}, { "t.Card": card });
  assert.ok(parent.find((el) => el.textContent === "card-body") !== null);
});

test("<node tag='list' bind> routes through the bound-collection reconciler", () => {
  const { parent } = mountTree(
    xml("node", { tag: "list", bind: "rows", key: "id" }, [xml("text", { value: "{{ item.label }}" })]),
    { rows: [{ id: "a", label: "Alpha" }, { id: "b", label: "Beta" }] },
  );
  assert.ok(parent.find((el) => el.textContent === "Alpha") !== null);
  assert.ok(parent.find((el) => el.textContent === "Beta") !== null);
});

test("an interpolated tag re-resolves live: element, other element, children fall-through, silent miss", () => {
  const { parent, store } = mountTree(
    xml("node", { tag: "{{ view }}", label: "Go" }, [xml("text", { value: "fallback-child" })]),
    { view: "button" },
  );
  assert.equal(parent.childAt(0).getAttribute("data-dsx-component"), "button");

  store.set("view", "text");
  flushEffects();
  assert.ok(parent.childAt(0).classList.contains("dsx-text"), "a changed tag remounts as the new element");

  store.set("view", "");
  flushEffects();
  assert.ok(parent.find((el) => el.textContent === "fallback-child") !== null, "empty resolution renders children");

  store.set("view", "ghost");
  flushEffects();
  assert.equal(parent.elementKids.length, 0, "an unknown resolution clears to nothing");
});

// ── <DSXWebView/>: the composed app web surface on the page's own origin ────────────

test("<DSXWebView/> mounts the policy-constrained iframe at the app's own origin, no warning", () => {
  const { result, warnings } = withWarnSpy(() => mountTree(xml("DSXWebView", {})));
  assert.deepEqual(warnings, [], "no unresolved-component warning");
  const frame = result.parent.childAt(0);
  assert.equal(frame.tagName, "IFRAME");
  assert.ok(frame.classList.contains("dsx-webview"));
  assert.equal(frame.src, "https://demo.example/", "path defaults to '/' against the page's own origin");
  assert.equal(webSurfaceRegistry().get("web")?.frame, frame as unknown as HTMLIFrameElement,
    "the surface registers under the Dom facet's default target name");
  result.ctx.disposers.forEach((dispose) => dispose());
  assert.equal(webSurfaceRegistry().get("web"), undefined);
});

test("<DSXWebView path origin> resolves origin+path; a bare path rides the page origin", () => {
  const at = mountTree(xml("DSXWebView", { origin: "https://pay.example", path: "/checkout" }));
  assert.equal(at.parent.childAt(0).src, "https://pay.example/checkout");
  at.ctx.disposers.forEach((dispose) => dispose());
  const local = mountTree(xml("DSXWebView", { path: "/settings" }));
  assert.equal(local.parent.childAt(0).src, "https://demo.example/settings");
  local.ctx.disposers.forEach((dispose) => dispose());
});

// ── <DSXView/>: the compiled-registry screen host + the dsx-view lifecycle ──────────

function collectLifecycle(): { events: Array<[string, unknown]>; off: () => void } {
  const events: Array<[string, unknown]> = [];
  const offs = ["loading", "ready", "failed", "disappear"].map((phase) =>
    DSXEvents.on(`dsx-view:${phase}`, (value) => events.push([phase, value])));
  return { events, off: () => offs.forEach((off) => off()) };
}

test("<DSXView src> renders the screen component this build ships, with the lifecycle events", () => {
  const home = compileComponent("Home", "t", `<stack><text value="home-screen"/></stack>`);
  const lifecycle = collectLifecycle();
  const { result, warnings } = withWarnSpy(() =>
    mountTree(xml("DSXView", { src: "Screens/Home.dsx" }), {}, { "t.Home": home }));
  lifecycle.off();
  assert.deepEqual(warnings, [], "no unresolved-component warning");
  const host = result.parent.childAt(0);
  assert.ok(host.classList.contains("dsx-view"));
  assert.ok(host.find((el) => el.textContent === "home-screen") !== null, "the named screen mounts");
  assert.deepEqual(lifecycle.events.map(([phase]) => phase), ["loading", "ready"]);
  assert.deepEqual(lifecycle.events[1]![1], { src: "Screens/Home.dsx", origin: "" });
});

test("<DSXView> without a src, or naming a screen this build does not ship, renders the labelled card", () => {
  const missing = mountTree(xml("DSXView", { src: "player/Nope.dsx" }));
  const card = missing.parent.childAt(0).childAt(0);
  assert.ok(card.classList.contains("dsx-view-unavailable"));
  assert.equal(card.getAttribute("role"), "status");
  assert.match(card.textContent, /Nope/);
  assert.equal(missing.parent.find((el) => el.classList.contains("dsx-unsupported")), null,
    "never the generic unsupported box");
  missing.ctx.disposers.forEach((dispose) => dispose());

  const lifecycle = collectLifecycle();
  const empty = mountTree(xml("DSXView", {}));
  lifecycle.off();
  assert.match(empty.parent.childAt(0).childAt(0).textContent, /not configured/i);
  assert.deepEqual(lifecycle.events.map(([phase]) => phase), ["loading", "failed"]);
  empty.ctx.disposers.forEach((dispose) => dispose());
});

test("a reactive src re-resolves the screen and unmount broadcasts disappear", () => {
  const home = compileComponent("Home", "t", `<stack><text value="home-screen"/></stack>`);
  const player = compileComponent("Player", "t", `<stack><text value="player-screen"/></stack>`);
  const { parent, store, ctx } = mountTree(
    xml("DSXView", { src: "{{ screen }}" }),
    { screen: "Home.dsx" },
    { "t.Home": home, "t.Player": player },
  );
  const host = parent.childAt(0);
  assert.ok(host.find((el) => el.textContent === "home-screen") !== null);

  store.set("screen", "despia/dsx/Player.dsx");
  flushEffects();
  assert.equal(host.find((el) => el.textContent === "home-screen"), null, "the old screen unmounts");
  assert.ok(host.find((el) => el.textContent === "player-screen") !== null);

  store.set("screen", "Gone.dsx");
  flushEffects();
  assert.ok(host.childAt(0).classList.contains("dsx-view-unavailable"));

  const lifecycle = collectLifecycle();
  ctx.disposers.forEach((dispose) => dispose());
  lifecycle.off();
  assert.deepEqual(lifecycle.events.map(([phase]) => phase), ["disappear"]);
});

test("a folder src folds to its folder-name screen (the DSXView.swift componentName rule)", () => {
  const player = compileComponent("player", "t", `<stack><text value="folder-root"/></stack>`);
  const { parent } = mountTree(
    xml("DSXView", { src: "https://cdn.example/despia/dsx/player/" }), {}, { "t.player": player });
  assert.ok(parent.childAt(0).find((el) => el.textContent === "folder-root") !== null);
});
