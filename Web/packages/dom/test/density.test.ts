//
//  density.test.ts — the density= universal subtree knob (component-library.md W9;
//  the shared law: Conformance/input/density.json). The contract under test: the
//  corpus fold + subtree resolution run verbatim, the renderer stamps
//  data-dsx-density only for a resolved pin (reactively, exactly the theme= pin),
//  and the token plane carries the knob — comfortable base, the desktop
//  fine-pointer platform default compact, and the pin tables that re-derive the
//  full control-metric plane for a subtree. The stamped tables plus custom-property
//  inheritance ARE the effective[] fold on this renderer.
//

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { ReactiveStore, ActionRunner, makeRunEnv, flushEffects } from "@despia-native/kernel";
import type { XmlNode } from "@despia-native/compiler/xml";
import type { Registry } from "@despia-native/compiler/resolve";
import {
  resolveDensity, effectiveDensity, mountNode, type MountCtx, type StackDensityValue,
} from "../src/mount.ts";
import { TOKENS_CSS, ELEMENTS_CSS, CONTROL_ELEMENTS_CSS } from "../src/theme.ts";

type ResolveCase = { name: string; density?: string; expect: StackDensityValue | null };
type EffectiveCase = {
  name: string;
  chain: (string | null)[];
  finePointer: boolean;
  expect: StackDensityValue;
};
const corpus = JSON.parse(readFileSync(
  new URL("../../../../Conformance/input/density.json", import.meta.url), "utf8",
)) as { version: number; resolve: ResolveCase[]; effective: EffectiveCase[] };

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
  readonly classList = new FakeClassList();
  readonly style = { setProperty: (): void => {}, removeProperty: (): void => {} };
  parent: FakeElement | null = null;
  private attrs = new Map<string, string>();
  kids: FakeElement[] = [];
  constructor(tag: string) { this.tagName = tag.toUpperCase(); }
  setAttribute(k: string, v: string): void { this.attrs.set(k, v); }
  getAttribute(k: string): string | null { return this.attrs.get(k) ?? null; }
  removeAttribute(k: string): void { this.attrs.delete(k); }
  appendChild(c: FakeElement): FakeElement { c.parent = this; this.kids.push(c); return c; }
  append(...cs: FakeElement[]): void { for (const c of cs) this.appendChild(c); }
  addEventListener(): void {}
  removeEventListener(): void {}
  querySelector(): null { return null; }
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

function mountOne(attrs: { [k: string]: string }): { el: FakeElement; store: ReactiveStore } {
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
  return { el: parent.childAt(0), store };
}

// ── the shared corpus, executed verbatim ────────────────────────────────────────────

test("shared density resolve corpus", () => {
  assert.equal(corpus.version, 1);
  assert.ok(corpus.resolve.length > 0, "resolve corpus must not be empty");
  for (const c of corpus.resolve) {
    assert.equal(resolveDensity(c.density), c.expect, c.name);
  }
});

test("shared density effective corpus", () => {
  assert.ok(corpus.effective.length > 0, "effective corpus must not be empty");
  for (const c of corpus.effective) {
    assert.equal(effectiveDensity(c.chain, c.finePointer), c.expect, c.name);
  }
});

// ── the renderer wiring ─────────────────────────────────────────────────────────────

test("density= stamps data-dsx-density for a resolved pin only, reactively", () => {
  assert.equal(mountOne({ density: "compact" }).el.getAttribute("data-dsx-density"), "compact");
  assert.equal(mountOne({ density: " comfortable " }).el.getAttribute("data-dsx-density"), "comfortable");
  assert.equal(mountOne({ density: "Compact" }).el.getAttribute("data-dsx-density"), null,
    "an invalid word never stamps — the subtree stays transparent to its ancestors");
  assert.equal(mountOne({}).el.getAttribute("data-dsx-density"), null);

  const { el, store } = mountOne({ density: "{{ d }}" });
  assert.equal(el.getAttribute("data-dsx-density"), null, "an empty binding is no pin");
  store.set("d", "compact");
  flushEffects();
  assert.equal(el.getAttribute("data-dsx-density"), "compact");
  store.set("d", "cozy");
  flushEffects();
  assert.equal(el.getAttribute("data-dsx-density"), null, "going invalid un-stamps");
});

test("the token plane carries the knob: base comfortable, media-default compact, pin tables", () => {
  const planeStart = TOKENS_CSS.indexOf("--dsx-control-height-sm: 32px;");
  assert.ok(planeStart > 0, "the comfortable density plane declares the control ramp");
  const mediaStart = TOKENS_CSS.indexOf("@media (min-width: 64rem) and (hover: hover) and (pointer: fine)");
  assert.ok(mediaStart > 0, "the platform default requires both room and a precision pointer");
  const media = TOKENS_CSS.slice(mediaStart, TOKENS_CSS.indexOf("}", TOKENS_CSS.indexOf("--dsx-textarea-density-pad-block", mediaStart)));
  for (const compactRow of [
    "--dsx-control-height: 32px;",
    "--dsx-control-height-sm: 28px;",
    "--dsx-control-height-lg: 36px;",
    "--dsx-button-density-pad: 0.625rem;",
    "--dsx-toggle-track-width: 51px;",
    "--dsx-slider-thumb-size: 18px;",
    "--dsx-field-density-pad: 0.75rem;",
  ]) {
    assert.ok(media.includes(compactRow), `the media default carries the full compact table: ${compactRow}`);
  }
  const comfortable = TOKENS_CSS.indexOf(`[data-dsx-density="comfortable"], :host([data-dsx-density="comfortable"])`);
  const compact = TOKENS_CSS.indexOf(`[data-dsx-density="compact"], :host([data-dsx-density="compact"])`);
  assert.ok(comfortable > 0 && compact > comfortable, "both pin tables exist, comfortable then compact");
  assert.ok(compact > mediaStart, "pin tables come after the platform default so a pin always wins");
  const comfortableTable = TOKENS_CSS.slice(comfortable, compact);
  assert.ok(comfortableTable.includes("--dsx-control-height: 40px;"), "a comfortable pin restores the 40px ramp");
  assert.ok(comfortableTable.includes("--dsx-radius-control: var(--dsx-radius);"),
    "derived radius tokens re-derive at the pin (custom properties inherit computed)");
  const compactTable = TOKENS_CSS.slice(compact, TOKENS_CSS.indexOf("@media (min-resolution: 2dppx)"));
  assert.ok(compactTable.includes("--dsx-control-height: 32px;"), "a compact pin compacts the ramp on any pointer");
  // theme pins no longer re-declare density tokens: a pinned density flows through them
  const themePinBlock = TOKENS_CSS.slice(TOKENS_CSS.indexOf(`[data-dsx-theme="dark"]`), TOKENS_CSS.indexOf(":root, :host, [data-dsx-theme] {"));
  assert.ok(!themePinBlock.includes("--dsx-control-height"), "theme pin tables carry colors, never density");
});

test("the control sheets consume the density plane, never re-declare it", () => {
  assert.ok(ELEMENTS_CSS.includes("--dsx-button-padding-inline: var(--dsx-button-density-pad);"));
  assert.ok(ELEMENTS_CSS.includes("--dsx-button-font-size: var(--dsx-button-density-type);"));
  assert.ok(ELEMENTS_CSS.includes("--dsx-button-radius: var(--dsx-button-density-radius);"));
  assert.ok(CONTROL_ELEMENTS_CSS.includes("height: var(--dsx-toggle-box-height);"));
  assert.ok(CONTROL_ELEMENTS_CSS.includes("--dsx-toggle-box-width: var(--dsx-toggle-track-width);"),
    "box width re-derives from the live track token so an author override reaches the painted box");
  assert.ok(CONTROL_ELEMENTS_CSS.includes("--dsx-toggle-travel: calc(var(--dsx-toggle-track-width) - var(--dsx-toggle-thumb-width)"),
    "travel re-derives from the live geometry tokens so an author restyle keeps the thumb on the track");
  assert.ok(CONTROL_ELEMENTS_CSS.includes("height: var(--dsx-slider-box-height);"));
  assert.ok(CONTROL_ELEMENTS_CSS.includes("padding: 0 var(--dsx-field-density-pad);"));
  for (const sheet of [ELEMENTS_CSS, CONTROL_ELEMENTS_CSS]) {
    assert.ok(!sheet.includes("--dsx-toggle-track-width: 36px")
      && !sheet.includes("--dsx-slider-thumb-size: 18px"),
      "no per-control fine-pointer metric override survives outside the plane (unified, not stacked)");
  }
});
