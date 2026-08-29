//
//  lottie-facet.test.ts — Wave 3 (b)3 (design-system.md): `<lottie>` is a MODULE
//  element — Core/Lottie ships a web facet (the /web/18 components table) and the
//  mount dispatch resolves a lowercase tag through the SAME facet loader Capitalized
//  facet tags ride, AFTER the builtin table. Without the module the literal tag keeps
//  the honest labelled unsupported box and a resolved dynamic tag keeps rendering
//  NOTHING — exclusion honesty is the contract, not a regression.
//
//  The player itself (vendored lottie-web light build) needs a real browser; these
//  tests drive the facet's STATE machine through mountNode with the fake DOM and a
//  stubbed fetch: loading → failed stays labelled and layout-honest, an empty src
//  keeps the native clear-frame zero footprint, and a reactive src reloads.
//

import { test as nodeTest } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { ReactiveStore, ActionRunner, makeRunEnv, flushEffects, ModuleRegistry } from "@despia-native/kernel";
import type { XmlNode } from "@despia-native/compiler/xml";
import type { Registry } from "@despia-native/compiler/resolve";
import { mountNode, type MountCtx } from "../src/mount.ts";

// The facet under test ships in ClosedSource; an open drop skips LOUDLY, per test,
// with the reason - never silently (the component-fold-conformance rule).
const hasClosedSource = existsSync(fileURLToPath(new URL("../../../../../ClosedSource", import.meta.url)));
const test: typeof nodeTest = hasClosedSource
  ? nodeTest
  : (((name: string) => nodeTest(name, (t) => t.skip("open drop without ClosedSource - Core/Lottie's web facet ships closed"))) as typeof nodeTest);
const lottieFacet = hasClosedSource
  ? (await import("../../../../../ClosedSource/DSX/Modules/Core/Lottie/web/index.js")).default
  : (undefined as never);

// ── the same minimal DOM stand-in as dynamic-node-and-surface-tags.test.ts ──────────

class FakeClassList {
  private owner: { className: string };
  constructor(owner: { className: string }) { this.owner = owner; }
  private read(): Set<string> {
    return new Set(this.owner.className.split(/\s+/).filter((c) => c.length > 0));
  }
  contains(c: string): boolean { return this.read().has(c); }
}

class FakeElement {
  tagName: string;
  nodeType = 1;
  className = "";
  textContent = "";
  hidden = false;
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
  remove(): void {
    if (this.parent !== null) this.parent.kids = this.parent.kids.filter((child) => child !== this);
    this.parent = null;
  }
  addEventListener(): void {}
  removeEventListener(): void {}
  getBoundingClientRect(): DOMRect {
    return { width: 320, height: 240 } as DOMRect;
  }
  get childNodes(): FakeElement[] { return [...this.kids]; }
  get firstChild(): FakeElement | null { return this.kids[0] ?? null; }
  childAt(i: number): FakeElement {
    const c = this.elementKids[i];
    if (c === undefined) throw new Error(`no element child at ${i}`);
    return c;
  }
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
  createElement: (t: string) => new FakeElement(t),
  createTextNode: (t: string) => {
    const node = new FakeElement("#text");
    node.nodeType = 3;
    node.textContent = t;
    return node;
  },
  createComment: (t: string) => {
    const node = new FakeElement(`#comment:${t}`);
    node.nodeType = 8;
    return node;
  },
  createDocumentFragment: () => new FakeElement("#fragment"),
};
(globalThis as { document?: unknown }).document = fakeDocument;
(globalThis as { window?: unknown }).window = {
  addEventListener: (): void => {},
  removeEventListener: (): void => {},
};

function xml(tag: string, attrs: Record<string, string> = {}, children: XmlNode[] = []): XmlNode {
  return { tag, attrs, children, text: "" };
}

function mountTree(node: XmlNode, seed: { [k: string]: unknown } = {}): {
  parent: FakeElement; store: ReactiveStore; ctx: MountCtx;
} {
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
  return { parent, store, ctx };
}

/** stub fetch with a controllable settle — the facet must never hit the network here */
function withFetch<T>(run: (calls: string[], reject: () => void) => T): T {
  const previous = (globalThis as { fetch?: unknown }).fetch;
  const calls: string[] = [];
  let rejectAll: Array<(reason: Error) => void> = [];
  (globalThis as { fetch: unknown }).fetch = (url: unknown) => {
    calls.push(String(url));
    return new Promise((_resolve, reject) => { rejectAll.push(reject); });
  };
  try {
    return run(calls, () => {
      for (const reject of rejectAll) reject(new Error("stubbed miss"));
      rejectAll = [];
    });
  } finally {
    (globalThis as { fetch?: unknown }).fetch = previous;
  }
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

// ── without the module: the honest degradations stay exactly as they were ───────────

test("<lottie> without the Core/Lottie module keeps the labelled unsupported box", () => {
  const { parent } = mountTree(xml("lottie", { src: "https://cdn.example/confetti.json" }));
  const box = parent.childAt(0);
  assert.ok(box.classList.contains("dsx-unsupported"), "exclusion keeps the honest box (Art. 7)");
  assert.equal(box.dataset["tag"], "lottie");
});

test("<node tag='lottie'> without the module renders NOTHING (the dynamic-tag law)", () => {
  const { parent } = mountTree(xml("node", { tag: "lottie" }));
  assert.equal(parent.elementKids.length, 0);
});

// ── with the module registered: the facet fills the tag through the element seam ────

test("the registered Core/Lottie web facet mounts <lottie> for real: loading → failed stays honest", async () => {
  ModuleRegistry.register(lottieFacet);
  await withFetch(async (calls, reject) => {
    const { parent } = mountTree(xml("lottie", { src: "https://cdn.example/confetti.json" }));
    const host = parent.childAt(0);
    assert.ok(host.classList.contains("dsx-facet"), "the /web/18 facet host, never the unsupported box");
    assert.equal(host.getAttribute("data-dsx-facet"), "lottie.lottie");
    const root = host.childAt(0);
    assert.ok(root.classList.contains("dsx-lottie"));
    assert.equal(root.getAttribute("data-dsx-lottie-state"), "loading");
    assert.deepEqual(calls, ["https://cdn.example/confetti.json"], "the src fetch is the only request");
    assert.equal(root.style.values.get("width"), "180px", "the unsized ideal box (the native 180pt twin)");

    reject();
    await settle();
    assert.equal(root.getAttribute("data-dsx-lottie-state"), "failed");
    assert.equal(root.getAttribute("data-dsx-lottie-playing"), "false");
    const card = root.find((el) => el.textContent === "Animation unavailable");
    assert.ok(card !== null, "the native failure copy, labelled, inside the element's own box");
  });
});

test("an empty src keeps the native clear-frame zero footprint, and a sized element fills its box", () => {
  withFetch(() => {
    const empty = mountTree(xml("lottie", {}));
    const emptyRoot = empty.parent.childAt(0).childAt(0);
    assert.equal(emptyRoot.getAttribute("data-dsx-lottie-state"), "empty");
    assert.equal(emptyRoot.style.values.get("width"), "0");

    const sized = mountTree(xml("lottie", { src: "https://cdn.example/a.json", width: "320", height: "240" }));
    const sizedRoot = sized.parent.childAt(0).childAt(0);
    assert.equal(sizedRoot.style.values.get("width"), "100%", "authored size wins the wrapper box");
  });
});

test("a reactive src reloads through update() — the facet contract's live half", async () => {
  await withFetch(async (calls) => {
    const { parent, store } = mountTree(
      xml("lottie", { src: "{{ anim }}" }),
      { anim: "https://cdn.example/one.json" },
    );
    const root = parent.childAt(0).childAt(0);
    assert.equal(root.getAttribute("data-dsx-lottie-state"), "loading");
    store.set("anim", "https://cdn.example/two.json");
    flushEffects();
    assert.equal(root.getAttribute("data-dsx-lottie-state"), "loading", "the change re-enters loading synchronously");
    await settle();
    assert.deepEqual(calls, ["https://cdn.example/one.json", "https://cdn.example/two.json"]);
    // in this DOM-less harness the vendored player import itself rejects, so the reload
    // settles on the honest failed card — the browser proof owns the ready/playing half
    assert.equal(root.getAttribute("data-dsx-lottie-state"), "failed");
  });
});

test("<node tag='lottie'> resolves the registered facet through the dynamic funnel too", () => {
  withFetch(() => {
    const { parent } = mountTree(xml("node", { tag: "lottie", src: "https://cdn.example/a.json" }));
    assert.equal(parent.childAt(0).getAttribute("data-dsx-facet"), "lottie.lottie");
  });
});

test("a builtin tag can never be shadowed by a module components row", () => {
  ModuleRegistry.register({
    scheme: "shadowtest",
    actions: {},
    components: { text: { mount: () => { throw new Error("a facet must never shadow a builtin"); } } },
  });
  const { parent } = mountTree(xml("text", { value: "still the builtin" }));
  const el = parent.childAt(0);
  assert.ok(el.classList.contains("dsx-text"));
  assert.ok(el.find((n) => n.textContent === "still the builtin") !== null);
});

test("unmount aborts the facet instance and empties the host subtree it owned", () => {
  withFetch(() => {
    const { parent, ctx } = mountTree(xml("lottie", { src: "https://cdn.example/a.json" }));
    assert.equal(parent.elementKids.length, 1);
    ctx.disposers.forEach((dispose) => dispose());
    const root = parent.childAt(0).childAt(0);
    assert.equal(root.childAt(0).elementKids.length, 0, "the stage was torn down");
  });
});
