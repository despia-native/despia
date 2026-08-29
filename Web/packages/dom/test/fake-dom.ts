//
//  fake-dom.ts - the minimal DOM stand-in the dom test files mount against.
//
//  node --test has no DOM and the suites here assert the binding engine, not a browser,
//  so this is a hand-written stand-in rather than a full emulator: it implements exactly
//  the surface mount.ts touches. Extracted from mount.test.ts when a second file needed
//  the same tree; importing it also INSTALLS the globals (document/window/observers),
//  which is why the import is for effect as well as for the classes.
//

// ── a minimal DOM stand-in (node --test runs this file in its own process) ──────────

export class FakeClassList {
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

export class FakeElement {
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
  toggleAttribute(k: string, force?: boolean): boolean {
    const on = force ?? !this.attrs.has(k);
    if (on) this.attrs.set(k, "");
    else this.attrs.delete(k);
    if (k === "inert") this.inert = on;
    return on;
  }
  appendChild(c: FakeElement): FakeElement {
    // real-DOM semantics: appending a fragment moves its children, not the fragment
    if (c.tagName === "#FRAGMENT") {
      for (const kid of [...c.kids]) this.appendChild(kid);
      return c;
    }
    if (c.parent !== null) c.parent.kids = c.parent.kids.filter((child) => child !== c);
    c.parent = this;
    this.kids.push(c);
    return c;
  }
  removeChild(c: FakeElement): FakeElement {
    this.kids = this.kids.filter((child) => child !== c);
    if (c.parent === this) c.parent = null;
    return c;
  }
  append(...cs: FakeElement[]): void { for (const c of cs) this.appendChild(c); }
  // mountKeep spreads `frag.childNodes` to take the mounted nodes off the fragment
  // before it appends them, so the live list has to be readable, not just writable.
  get childNodes(): FakeElement[] { return [...this.kids]; }
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

export class FakeEvent {
  defaultPrevented = false;
  readonly type: string;
  readonly key: string;
  constructor(type: string, key = "") { this.type = type; this.key = key; }
  preventDefault(): void { this.defaultPrevented = true; }
  stopPropagation(): void {}
}

export const fakeDocument = {
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
// element-motion's htmlElements() narrows with `instanceof HTMLElement` before it touches
// style/inert, so the guard needs a constructor to recognise or every mounted node is
// filtered out and the motion branches silently do nothing.
(globalThis as { HTMLElement?: unknown }).HTMLElement = FakeElement;
(globalThis as { window?: unknown }).window = {
  addEventListener: (): void => {},
  removeEventListener: (): void => {},
};

export class FakeIntersectionObserver {
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

