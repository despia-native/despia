//
//  shortcut.test.ts — the `shortcut=` keyboard accelerator + `focusOrder` traversal
//  primitive (desktop-platforms.md input grammar). Contract: a mounted element with
//  shortcut= listens document-wide, `cmd` matches the PRIMARY modifier (meta or
//  ctrl), a match preventDefaults and runs the tap action, an unmodified shortcut
//  never steals keys from an editable target, and unmount removes the listener.
//  focusOrder maps to tabIndex verbatim.
//
//  Same in-process fake-DOM harness as hover.test.ts, plus a document stub that
//  records keydown listeners so the test can dispatch.
//

import { test } from "node:test";
import assert from "node:assert/strict";

import { ReactiveStore, ActionRunner, makeRunEnv } from "@despia/kernel";
import type { XmlNode } from "@despia/compiler/xml";
import type { Registry } from "@despia/compiler/resolve";
import { mountNode, type MountCtx } from "../src/mount.ts";

class FakeClassList {
  add(): void {}
  remove(): void {}
  toggle(): void {}
  contains(): boolean { return false; }
}

class FakeElement {
  tagName: string;
  className = "";
  textContent = "";
  type = "";
  tabIndex = 0;
  readonly classList = new FakeClassList();
  readonly style = { setProperty: (): void => {}, removeProperty: (): void => {} };
  private attrs = new Map<string, string>();
  private kids: FakeElement[] = [];
  constructor(tag: string) { this.tagName = tag.toUpperCase(); }
  setAttribute(k: string, v: string): void { this.attrs.set(k, v); }
  getAttribute(k: string): string | null { return this.attrs.get(k) ?? null; }
  removeAttribute(k: string): void { this.attrs.delete(k); }
  appendChild(c: FakeElement): FakeElement { this.kids.push(c); return c; }
  append(...cs: FakeElement[]): void { this.kids.push(...cs); }
  prepend(c: FakeElement): void { this.kids.unshift(c); }
  querySelector(): null { return null; }
  addEventListener(): void {}
  click(): void {}
  childAt(i: number): FakeElement {
    const c = this.kids[i];
    if (c === undefined) throw new Error(`no child at ${i}`);
    return c;
  }
}

type KeyListener = (e: unknown) => void;
const docListeners: KeyListener[] = [];

(globalThis as { document?: unknown }).document = {
  createElement: (t: string) => new FakeElement(t),
  createElementNS: (_ns: string, t: string) => new FakeElement(t),
  createComment: (t: string) => new FakeElement(`#comment:${t}`),
  createDocumentFragment: () => new FakeElement("#fragment"),
  addEventListener: (_t: string, fn: KeyListener) => { docListeners.push(fn); },
  removeEventListener: (_t: string, fn: KeyListener) => {
    const i = docListeners.indexOf(fn);
    if (i >= 0) docListeners.splice(i, 1);
  },
};

function pressKey(init: {
  key: string; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean;
  target?: { tagName?: string; isContentEditable?: boolean };
}): { defaultPrevented: boolean } {
  const e = {
    key: init.key,
    metaKey: init.metaKey ?? false,
    ctrlKey: init.ctrlKey ?? false,
    altKey: init.altKey ?? false,
    shiftKey: init.shiftKey ?? false,
    target: init.target ?? { tagName: "BODY" },
    defaultPrevented: false,
    preventDefault(): void { this.defaultPrevented = true; },
  };
  for (const fn of [...docListeners]) fn(e);
  return e;
}

function mountOne(attrs: { [k: string]: string }): { el: FakeElement; store: ReactiveStore; ctx: MountCtx } {
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
  return { el: parent.childAt(0), store, ctx };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

test("cmd+s runs the tap action on either primary modifier and preventDefaults", async () => {
  docListeners.length = 0;
  const { store } = mountOne({ "shortcut": "cmd+s", "on:tap": "saved = true" });
  const miss = pressKey({ key: "s" });
  await settle();
  assert.equal(store.vars.get("saved"), undefined);
  assert.equal(miss.defaultPrevented, false);
  const meta = pressKey({ key: "s", metaKey: true });
  await settle();
  assert.equal(store.vars.get("saved"), true);
  assert.equal(meta.defaultPrevented, true, "the browser's own cmd+s must lose");
  store.set("saved", false);
  pressKey({ key: "S", ctrlKey: true });
  await settle();
  assert.equal(store.vars.get("saved"), true);
});

test("an unmodified shortcut never steals keys from an editable target", async () => {
  docListeners.length = 0;
  const { store } = mountOne({ "shortcut": "n", "on:tap": "made = true" });
  pressKey({ key: "n", target: { tagName: "INPUT" } });
  await settle();
  assert.equal(store.vars.get("made"), undefined, "typing in a field is not a shortcut");
  pressKey({ key: "n", target: { tagName: "BODY" } });
  await settle();
  assert.equal(store.vars.get("made"), true);
});

test("unmount removes the document listener", () => {
  docListeners.length = 0;
  const { ctx } = mountOne({ "shortcut": "cmd+k", "on:tap": "x = 1" });
  assert.equal(docListeners.length, 1);
  for (const d of ctx.disposers) d();
  assert.equal(docListeners.length, 0, "disposers must detach the accelerator");
});

test("focusOrder maps to tabIndex verbatim", () => {
  docListeners.length = 0;
  const { el } = mountOne({ "focusOrder": "3" });
  assert.equal(el.tabIndex, 3);
});
