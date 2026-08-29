//
//  form-lifecycle.test.ts — the WATCH-BEFORE-MOUNT write (wave-7 F4): an action fired
//  by a `<watch>` writes into a form namespace whose pane has not mounted yet. The
//  write must land VERBATIM (a string stays that string), survive the pane mounting
//  afterwards (ensureNamespace must not clobber it), and paint into the control. The
//  regression this pins: the pre-mount write surfacing as a coerced "0" in the field.
//
//  node --test runs this file in its own process; the DOM stand-in below is the
//  mount.test.ts shape plus fragment childNodes + comment anchors (visible-if inserts
//  through them).
//

import { test } from "node:test";
import assert from "node:assert/strict";

import { ReactiveStore, ActionRunner, makeRunEnv, flushEffects } from "@despia/kernel";
import { compileComponent } from "@despia/compiler/component";
import type { Registry } from "@despia/compiler/resolve";

// ── the DOM stand-in ─────────────────────────────────────────────────────────────────

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

class FakeNode {
  nodeType = 1;
  tagName: string;
  className = "";
  id = "";
  htmlFor = "";
  textContent = "";
  value = "";
  type = "";
  rows = 0;
  placeholder = "";
  required = false;
  checked = false;
  disabled = false;
  hidden = false;
  noValidate = false;
  maxLength = -1;
  inputMode = "";
  tabIndex = 0;
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
  kids: FakeNode[] = [];
  parent: FakeNode | null = null;
  private listeners = new Map<string, Array<(event: { preventDefault(): void }) => void>>();
  constructor(tag: string) { this.tagName = tag.toUpperCase(); }
  setAttribute(k: string, v: string): void { this.attrs.set(k, v); }
  getAttribute(k: string): string | null { return this.attrs.get(k) ?? null; }
  removeAttribute(k: string): void { this.attrs.delete(k); }
  appendChild(c: FakeNode): FakeNode {
    c.remove();
    c.parent = this;
    this.kids.push(c);
    return c;
  }
  append(...cs: FakeNode[]): void { for (const c of cs) this.appendChild(c); }
  after(...nodes: FakeNode[]): void {
    const parent = this.parent;
    if (parent === null) return;
    for (const n of nodes) n.remove();
    const at = parent.kids.indexOf(this);
    parent.kids.splice(at + 1, 0, ...nodes);
    for (const n of nodes) n.parent = parent;
  }
  remove(): void {
    if (this.parent !== null) this.parent.kids = this.parent.kids.filter((k) => k !== this);
    this.parent = null;
  }
  addEventListener(type: string, listener: (event: { preventDefault(): void }) => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }
  listenerCount(type: string): number { return this.listeners.get(type)?.length ?? 0; }
  focus(): void {}
  get childNodes(): FakeNode[] { return [...this.kids]; }
  get firstElementChild(): FakeNode | null { return this.kids.find((k) => k.nodeType === 1) ?? null; }
  /** depth-first search over the stand-in (querySelector is not modeled) */
  find(match: (n: FakeNode) => boolean): FakeNode | null {
    if (match(this)) return this;
    for (const k of this.kids) {
      const hit = k.find(match);
      if (hit !== null) return hit;
    }
    return null;
  }
}

const fakeDocument = {
  baseURI: "https://demo.example/",
  activeElement: null,
  createElement: (t: string) => new FakeNode(t),
  createElementNS: (_ns: string, t: string) => new FakeNode(t),
  createTextNode: (t: string) => {
    const node = new FakeNode("#text");
    node.nodeType = 3;
    node.textContent = t;
    return node;
  },
  createComment: (t: string) => {
    const node = new FakeNode(`#comment`);
    node.nodeType = 8;
    node.textContent = t;
    return node;
  },
  createDocumentFragment: () => {
    const node = new FakeNode("#fragment");
    node.nodeType = 11;
    return node;
  },
};
(globalThis as { document?: unknown }).document = fakeDocument;
(globalThis as { window?: unknown }).window = {
  addEventListener: (): void => {},
  removeEventListener: (): void => {},
};

const { instantiate } = await import("../src/mount.ts");
const { ELEMENTS } = await import("../src/elements.ts");
const { FORM_ELEMENTS } = await import("../src/forms.ts");
Object.assign(ELEMENTS, FORM_ELEMENTS);

function build(source: string): { root: FakeNode; store: ReactiveStore; unmount: () => void } {
  const ir = compileComponent("Screen", "t", source);
  const registry: Registry = {
    components: { "t.Screen": ir }, globalPool: { Screen: "t.Screen" }, css: "", schemes: [],
  };
  const instance = instantiate(ir, registry, {});
  return {
    root: instance.root as unknown as FakeNode,
    store: instance.ctx.store,
    unmount: instance.unmount,
  };
}

const tick = async (): Promise<void> => {
  // runner.run is async — drain the action's microtasks, then the binding flush
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
  flushEffects();
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
  flushEffects();
};

function control(root: FakeNode, name: string): FakeNode {
  const hit = root.find((n) => n.getAttribute("name") === name);
  assert.ok(hit !== null, `field control "${name}" mounted`);
  return hit;
}

test("a watch-fired write into a NOT-YET-MOUNTED form namespace lands verbatim and paints on mount", async () => {
  const { root, store, unmount } = build(`<stack>
    <head>
      <variable as="ready">false</variable>
      <variable as="show">false</variable>
      <variable as="source">return null</variable>
      <action as="seed">
        editor.values.title = source.title
        editor.values.body = source.body ? source.body : ''
      </action>
      <watch value="dsx.variable.ready" on:change="seed()"/>
    </head>
    <stack visible-if="dsx.variable.show">
      <form as="editor">
        <field name="title" label="Title"/>
        <field name="body" label="Note"/>
      </form>
    </stack>
  </stack>`);

  // the watch fires FIRST, while the pane is still unmounted
  store.set("source", { title: "First light", body: null });
  store.set("ready", true);
  await tick();
  assert.equal(store.getPath("editor.values.title"), "First light",
    "the unmounted-namespace write stores the STRING verbatim");
  assert.equal(root.find((n) => n.getAttribute("name") === "title"), null, "pane still unmounted");

  // now the pane mounts — ensureNamespace must keep the pre-mount values
  store.set("show", true);
  flushEffects();
  await tick();
  assert.equal(store.getPath("editor.values.title"), "First light",
    "mounting the form must not clobber pre-mount values");
  assert.equal(control(root, "title").value, "First light", "the control paints the stored string");
  assert.notEqual(control(root, "title").value, "0", "never the coerced zero");
  assert.equal(control(root, "body").value, "", "guarded null coalesces to empty");
  unmount();
});

test("multiline=true mounts a real three-row textarea in the same well, off the Enter chain (wave-7 F5)", async () => {
  const { root, store, unmount } = build(`<stack>
    <form as="editor">
      <field name="body" label="Note" multiline="true"/>
      <field name="title" label="Title"/>
    </form>
  </stack>`);
  await tick();

  const body = control(root, "body");
  assert.equal(body.tagName, "TEXTAREA", "multiline is a real textarea");
  assert.equal(body.rows, 3, "three-line floor");
  assert.ok(body.classList.contains("dsx-field-control"), "the same well class — lane B's styling applies");
  assert.ok(body.classList.contains("dsx-field-multiline"));
  assert.equal(control(root, "title").tagName, "INPUT", "a plain field stays an input");

  // the store paints in, newlines intact
  store.setPath("editor.values.body", "one\ntwo\nthree");
  await tick();
  assert.equal(body.value, "one\ntwo\nthree");

  // Enter belongs to the textarea (no advance-to-next/submit listener attached)
  assert.equal(body.listenerCount("keydown"), 0, "no Enter-advance keydown on multiline");
  assert.ok(control(root, "title").listenerCount("keydown") > 0, "single-line fields keep Return-to-next");
  unmount();
});

test("a pre-mount boolean write reaches a toggle as its checked state, never a coerced string", async () => {
  const { root, store, unmount } = build(`<stack>
    <head>
      <variable as="show">false</variable>
      <action as="seed">
        prefs.values.dark = dsx.global.settings &amp;&amp; dsx.global.settings.dark ? true : false
      </action>
      <watch value="dsx.variable.show" on:change="seed()"/>
    </head>
    <stack visible-if="dsx.variable.show">
      <form as="prefs">
        <field name="dark" type="toggle" label="Dark appearance"/>
      </form>
    </stack>
  </stack>`);

  store.set("show", true);
  await tick();
  await tick();
  assert.equal(store.getPath("prefs.values.dark"), false, "the boolean stays a boolean");
  const toggle = control(root, "dark");
  assert.equal(toggle.type, "checkbox");
  assert.equal(toggle.checked, false);
  assert.equal(toggle.value, "", "no string coercion leaks into the control value");
  unmount();
});

test("field disabled= / disabled-if= reach the real control and stamp the root (W9 grammar)", async () => {
  const { root, store, unmount } = build(`<stack>
    <head><variable as="locked">true</variable></head>
    <form as="prefs">
      <field name="email" type="email" label="Email" disabled-if="dsx.variable.locked"/>
      <field name="frozen" type="text" label="Frozen" disabled="true"/>
    </form>
  </stack>`);
  await tick();
  const email = control(root, "email");
  assert.equal((email as unknown as { disabled?: boolean }).disabled, true, "the bound lock disables the control");
  assert.equal((control(root, "frozen") as unknown as { disabled?: boolean }).disabled, true, "a declared disabled holds");
  store.set("locked", false);
  await tick();
  assert.equal((email as unknown as { disabled?: boolean }).disabled, false, "a reactive re-enable restores the field");
  unmount();
});
