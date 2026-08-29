//
//  adopt-parity.test.ts — ADOPT-WIRING PARITY (design-system.md Wave 4, the named
//  defect): an SSR-adopted page must be exactly as alive as a fresh client mount.
//  The island gate (adopt.ts isIslandRoot) may reuse a server subtree verbatim ONLY
//  when a fresh mount of the same nodes would attach nothing — the compiler's
//  reactive bit alone does not prove that, because wireCommon and the factories
//  attach wiring regardless of reactivity. Pinned here, against REAL server output
//  through the same harness style as adopt.test.ts:
//    • tooltip= on an element inside an otherwise-inert subtree wires the bubble +
//      aria-describedby on the ADOPTED element (identity preserved);
//    • an icon-form <image> inside such a subtree hydrates its client-only svg
//      (claimed and rebuilt in place, never left an empty slot);
//    • an href= pressable inside such a subtree keeps its server anchor and gets
//      the live link wiring (data-dsx-href, component semantics);
//    • handler-less buttons still adopt their factory semantics (data-dsx-component,
//      label part, focusOrder tab order) instead of being skipped;
//    • genuinely inert presentational content STILL skips as an island — the
//      optimization survives, at finer granularity, with zero mismatches.
//
//  node --test runs this file in its own process; the DOM stand-in mirrors
//  adopt.test.ts (the walk traverses siblings, claims cursors, swaps subtrees),
//  plus a document.body so tooltip bubbles land somewhere assertable.
//

import { test } from "node:test";
import assert from "node:assert/strict";

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
  id = "";
  checked = false;
  disabled = false;
  hidden = false;
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
  /** test helper: was any listener attached for this event type? */
  hasListener(type: string): boolean { return (this.listeners.get(type) ?? []).length > 0; }
  dispatch(type: string): FakeEvent {
    const event = new FakeEvent(type);
    for (const l of this.listeners.get(type) ?? []) l(event);
    return event;
  }
  click(): void {
    if (this.disabled) return;
    this.dispatch("click");
  }
  focus(): void {}
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
  constructor(type: string) { this.type = type; }
  preventDefault(): void { this.defaultPrevented = true; }
  stopPropagation(): void {}
  stopImmediatePropagation(): void {}
}

const fakeDocument = {
  baseURI: "https://demo.example/",
  body: new FakeElement("body"),
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

/** server-render with stamps, parse, adopt; returns the host + instance + server root */
function adoptOf(registry: Registry, qualified: string) {
  const html = renderToString(registry, qualified, {}, { hydrate: true });
  const host = parseHtml(html);
  const serverRoot = host.firstElementChild!;
  resetHydrationReport();
  fakeDocument.body.replaceChildren();
  const instance = instantiate(registry.components[qualified]!, registry, {
    adopt: serverRoot as unknown as Element,
  });
  return { html, host, serverRoot, instance };
}

// The parity fixture: a reactive shell (the realistic page shape) whose gallery-style
// subtrees carry NO reactive binding anywhere — before the wiring-aware island gate,
// every one of them was skipped wholesale and adopted dead.
const PARITY = registryOf({
  "t.Parity": `<stack>
    <head><variable as="live">return 'shell'</variable></head>
    <text value="{{ live }}"/>
    <hstack class="hints">
      <button label="Save" tooltip="Save the draft"/>
      <button label="Next" variant="bordered" focusOrder="3"/>
    </hstack>
    <hstack class="trail">
      <pressable href="/quickstart"><text value="Quickstart"/></pressable>
      <image icon="chevron.right" iconSize="11"/>
      <text value="Here"/>
    </hstack>
    <stack class="calm">
      <text value="alpha"/>
      <divider/>
    </stack>
  </stack>`,
});

// ── the tests ────────────────────────────────────────────────────────────────────────

test("adopt parity: tooltip= inside an inert-marked subtree wires on the ADOPTED element", () => {
  const html = renderToString(PARITY, "t.Parity", {}, { hydrate: true });
  const host = parseHtml(html);
  const serverRoot = host.firstElementChild!;
  const serverSave = serverRoot.find((el) => el.tagName === "BUTTON" && el.textContent === "Save")!;
  assert.ok(serverSave !== null, "server rendered the tooltip button");
  assert.equal(serverSave.getAttribute("aria-describedby"), null, "server markup carries no description yet");

  resetHydrationReport();
  fakeDocument.body.replaceChildren();
  const instance = instantiate(PARITY.components["t.Parity"]!, PARITY, { adopt: serverRoot as unknown as Element });
  const report = hydrationReport();
  assert.equal(report.mismatches, 0, "parity wiring never diverges on in-sync output");

  // the SAME server element got the tooltip wiring — identity preserved, not replaced
  const save = host.find((el) => el.tagName === "BUTTON" && el.textContent === "Save")!;
  assert.equal(save as unknown, serverSave as unknown, "the wired button IS the server element");
  const described = save.getAttribute("aria-describedby") ?? "";
  assert.match(described, /^dsx-tooltip-\d+$/, "aria-describedby names the bubble");
  const bubble = fakeDocument.body.find((el) => el.getAttribute("role") === "tooltip" && el.id === described);
  assert.ok(bubble !== null, "the role=tooltip bubble exists");
  assert.equal(bubble!.textContent, "Save the draft", "the bubble carries the hint text");
  assert.equal(bubble!.hidden, true, "hidden at rest — reveal stays hover/focus gated");
  assert.ok(save.hasListener("pointerenter") && save.hasListener("focus"), "hover + focus reveal wiring attached");
  instance.unmount();
});

test("adopt parity: an icon-form <image> in an inert-marked subtree hydrates its svg", () => {
  const { host, instance } = adoptOf(PARITY, "t.Parity");
  const report = hydrationReport();
  assert.equal(report.mismatches, 0);
  assert.ok(report.rebuilt >= 1, "the icon image is machinery: claimed then rebuilt in place");
  const icon = host.find((el) => el.classList.contains("dsx-icon"));
  assert.ok(icon !== null, "the icon wrapper replaced the empty server img");
  assert.ok(icon!.find((el) => el.tagName === "SVG") !== null, "…and carries the client-only svg");
  assert.equal(host.find((el) => el.tagName === "IMG"), null, "no dead icon slot remains");
  instance.unmount();
});

test("adopt parity: an href pressable in an inert-marked subtree keeps its anchor and gets link wiring", () => {
  const html = renderToString(PARITY, "t.Parity", {}, { hydrate: true });
  const host = parseHtml(html);
  const serverRoot = host.firstElementChild!;
  const serverLink = serverRoot.find((el) => el.tagName === "A" && el.getAttribute("href") === "/quickstart")!;
  assert.ok(serverLink !== null, "server rendered the crawlable anchor");

  resetHydrationReport();
  fakeDocument.body.replaceChildren();
  const instance = instantiate(PARITY.components["t.Parity"]!, PARITY, { adopt: serverRoot as unknown as Element });
  assert.equal(hydrationReport().mismatches, 0);

  const link = host.find((el) => el.tagName === "A" && el.getAttribute("href") === "/quickstart")!;
  assert.equal(link as unknown, serverLink as unknown, "the wired anchor IS the server element");
  assert.equal(link.getAttribute("data-dsx-component"), "pressable", "factory semantics stamped");
  assert.equal(link.getAttribute("data-dsx-href"), "/quickstart", "the live link binding ran");
  assert.ok(link.hasListener("click"), "the SPA navigation interceptor attached");
  instance.unmount();
});

test("adopt parity: handler-less buttons adopt their factory semantics instead of skipping", () => {
  const { host, instance } = adoptOf(PARITY, "t.Parity");
  const next = host.find((el) => el.tagName === "BUTTON" && el.textContent === "Next")!;
  assert.ok(next !== null);
  assert.equal(next.getAttribute("data-dsx-component"), "button", "component semantics stamped on adoption");
  assert.equal(next.tabIndex, 3, "focusOrder= tab order applied (no server twin exists for it)");
  const label = next.find((el) => el.tagName === "SPAN")!;
  assert.equal(label.getAttribute("data-dsx-part"), "label", "the server label span was claimed as the binding target");
  instance.unmount();
});

test("adopt parity: genuinely inert presentational content still skips as an island", () => {
  const { host, serverRoot, instance } = adoptOf(PARITY, "t.Parity");
  const report = hydrationReport();
  assert.equal(report.mismatches, 0);
  // the calm stack (text + divider, wiring-free throughout) and the pressable's inner
  // text are still islands — the optimization survives at finer granularity
  assert.ok(report.islandsSkipped >= 1, `wiring-free content still islands (got ${report.islandsSkipped})`);
  const alpha = serverRoot.find((el) => el.tagName === "SPAN" && el.textContent === "alpha");
  assert.ok(alpha !== null && alpha.isConnected, "island content is the reused server element");
  const calm = host.find((el) => el.classList.contains("calm"));
  assert.ok(calm !== null && calm.contains(alpha!), "…still in place under its parent");
  instance.unmount();
});
