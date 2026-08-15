//
//  hover.test.ts — the on:hoverStart / on:hoverEnd pointer-hover lifecycle
//  (desktop-platforms.md input grammar). The contract under test: handlers bind to
//  pointerenter/pointerleave, run through the REAL action runner (store writes land),
//  and are capability-gated by `(any-hover: hover)` plus pointer type — a touch
//  event never fires the pair, while a touch-primary hybrid's mouse still can.
//
//  Same in-process fake-DOM harness as mount.test.ts, except addEventListener
//  RECORDS listeners so the test can dispatch.
//

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { ReactiveStore, ActionRunner, makeRunEnv } from "@despia/kernel";
import type { XmlNode } from "@despia/compiler/xml";
import type { Registry } from "@despia/compiler/resolve";
import { HoverLifecycle, mountNode, type HoverLifecycleAction, type MountCtx } from "../src/mount.ts";

type HoverCorpusEvent = {
  type: "enter" | "leave" | "cancel" | "unmount";
  pointer?: string;
  kind?: string;
  hoverCapable?: boolean;
};
type HoverCorpusCase = {
  name: string;
  events: HoverCorpusEvent[];
  expect: HoverLifecycleAction[];
  expectActive: string[];
};
const hoverCorpus = JSON.parse(readFileSync(
  new URL("../../../../Conformance/input/hover.json", import.meta.url), "utf8",
)) as { version: number; cases: HoverCorpusCase[] };

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
  readonly listeners: { [type: string]: Array<(e?: unknown) => void> } = {};
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
  addEventListener(type: string, fn: (e?: unknown) => void): void {
    (this.listeners[type] ??= []).push(fn);
  }
  dispatch(type: string, event: unknown = { pointerType: "mouse", pointerId: 1 }): void {
    for (const fn of this.listeners[type] ?? []) fn(event);
  }
  childAt(i: number): FakeElement {
    const c = this.kids[i];
    if (c === undefined) throw new Error(`no child at ${i}`);
    return c;
  }
}

(globalThis as { document?: unknown }).document = {
  createElement: (t: string) => new FakeElement(t),
  createElementNS: (_ns: string, t: string) => new FakeElement(t),
  createComment: (t: string) => new FakeElement(`#comment:${t}`),
  createDocumentFragment: () => new FakeElement("#fragment"),
};

function setHoverCapability(matches: boolean): void {
  (globalThis as { matchMedia?: unknown }).matchMedia = (query: string) =>
    ({ matches: query === "(any-hover: hover)" ? matches : false });
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

/** drain the runner's render-safe microtask hop before asserting store effects */
async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

test("shared hover lifecycle corpus", () => {
  assert.equal(hoverCorpus.version, 1);
  assert.ok(hoverCorpus.cases.length > 0, "hover corpus must not be empty");
  for (const c of hoverCorpus.cases) {
    const hover = new HoverLifecycle();
    const actions: HoverLifecycleAction[] = [];
    for (const event of c.events) {
      if (event.type === "enter") {
        actions.push(...hover.enter(
          event.pointer ?? "",
          event.kind ?? "unknown",
          event.hoverCapable === true,
        ));
      } else if (event.type === "leave") {
        actions.push(...hover.leave(event.pointer ?? ""));
      } else if (event.type === "cancel") {
        actions.push(...hover.cancel(event.pointer ?? ""));
      } else {
        actions.push(...hover.unmount());
      }
    }
    assert.deepEqual(actions, c.expect, c.name);
    assert.deepEqual([...hover.activePointers].map(String).sort(), [...c.expectActive].sort(), c.name);
  }
});

test("hover lifecycle fires on a hover-capable pointer and writes the store", async () => {
  setHoverCapability(true);
  const { el, store } = mountOne({
    "on:hoverStart": "hovered = true",
    "on:hoverEnd": "hovered = false",
  });
  assert.ok(el.listeners["pointerenter"]?.length, "hoverStart binds pointerenter");
  assert.ok(el.listeners["pointerleave"]?.length, "hoverEnd binds pointerleave");
  el.dispatch("pointerenter");
  await settle();
  assert.equal(store.vars.get("hovered"), true, "on:hoverStart ran through the runner");
  el.dispatch("pointerleave");
  await settle();
  assert.equal(store.vars.get("hovered"), false, "on:hoverEnd ran through the runner");
});

test("a touch target (hover: none) NEVER fires the pair — Article-7 degradation", async () => {
  setHoverCapability(true);
  const { el, store } = mountOne({ "on:hoverStart": "hovered = true" });
  el.dispatch("pointerenter", { pointerType: "touch", pointerId: 2 });
  await settle();
  assert.equal(store.vars.get("hovered"), undefined, "touch-synthesized pointerenter never fakes hover");
});

test("a touch-primary hybrid still hovers with its real mouse", async () => {
  setHoverCapability(true);
  const { el, store } = mountOne({ "on:hoverStart": "hovered = true" });
  el.dispatch("pointerenter", { pointerType: "mouse", pointerId: 1 });
  await settle();
  assert.equal(store.vars.get("hovered"), true);
});

test("hoverEnd stays paired if capability changes after pointerenter", async () => {
  setHoverCapability(true);
  const { el, store } = mountOne({
    "on:hoverStart": "hovered = true",
    "on:hoverEnd": "hovered = false",
  });
  el.dispatch("pointerenter", { pointerType: "mouse", pointerId: 1 });
  await settle();
  setHoverCapability(false);
  el.dispatch("pointerleave", { pointerType: "mouse", pointerId: 1 });
  await settle();
  assert.equal(store.vars.get("hovered"), false, "an entered hover must always receive its end");
});

test("elements without hover handlers bind no hover listeners", () => {
  setHoverCapability(true);
  const { el } = mountOne({ "on:tap": "x = 1" });
  assert.equal(el.listeners["pointerenter"], undefined);
  assert.equal(el.listeners["pointerleave"], undefined);
});

test("an unrelated touch pointer cannot end an active mouse hover", async () => {
  setHoverCapability(true);
  const { el, store } = mountOne({
    "on:hoverStart": "hovered = true",
    "on:hoverEnd": "hovered = false",
  });
  el.dispatch("pointerenter", { pointerType: "mouse", pointerId: 7 });
  await settle();
  el.dispatch("pointerleave", { pointerType: "touch", pointerId: 9 });
  await settle();
  assert.equal(store.vars.get("hovered"), true);
  el.dispatch("pointerleave", { pointerType: "mouse", pointerId: 7 });
  await settle();
  assert.equal(store.vars.get("hovered"), false);
});

test("duplicate enter is deduplicated and pointercancel balances the pair", async () => {
  setHoverCapability(true);
  const { el, store } = mountOne({
    "on:hoverStart": "starts = (starts ?? 0) + 1",
    "on:hoverEnd": "ends = (ends ?? 0) + 1",
  });
  el.dispatch("pointerenter", { pointerType: "mouse", pointerId: 5 });
  el.dispatch("pointerenter", { pointerType: "mouse", pointerId: 5 });
  await settle();
  assert.equal(store.vars.get("starts"), 1);
  el.dispatch("pointercancel", { pointerType: "mouse", pointerId: 5 });
  el.dispatch("pointercancel", { pointerType: "mouse", pointerId: 5 });
  await settle();
  assert.equal(store.vars.get("ends"), 1);
});

test("unmount balances an active hover lifecycle", async () => {
  setHoverCapability(true);
  const { el, store, ctx } = mountOne({
    "on:hoverStart": "hovered = true",
    "on:hoverEnd": "hovered = false",
  });
  el.dispatch("pointerenter", { pointerType: "mouse", pointerId: 4 });
  await settle();
  assert.equal(store.vars.get("hovered"), true);
  for (const dispose of ctx.disposers) dispose();
  await settle();
  assert.equal(store.vars.get("hovered"), false);
});
