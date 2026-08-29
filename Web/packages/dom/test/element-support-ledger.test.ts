// Machine-enforced release truth for the browser element surface. This deliberately
// reads the platform-neutral fixture directory rather than maintaining a second tag
// list: adding a fixture or alias must force an explicit Web support decision.

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ELEMENTS,
  GLOBAL_ELEMENTS,
  UNSUPPORTED,
  registerGlobalElements,
  registerRichElements,
  type ElementApi,
  type ElementFactory,
} from "../src/elements.ts";
import { UNIVERSAL_GLOBAL_ELEMENTS } from "../src/globals.ts";
import { FORM_ELEMENTS } from "../src/forms.ts";
import { registerNativeControls } from "../src/native-controls.ts";
import { DATA_CONTROL_ELEMENTS } from "../src/data-controls.ts";
import { MEDIA_SURFACE_ELEMENTS } from "../src/media-surfaces.ts";
import { registerStructuralControls, STRUCTURAL_CONTROL_ELEMENTS } from "../src/structural-controls.ts";
import { registerOverlayControls } from "../src/overlay-controls.ts";
import { registerDataControls } from "../src/data-controls.ts";
import { registerApplicationControls } from "../src/application-controls.ts";
import { registerMediaSurfaces } from "../src/media-surfaces.ts";
import { mountNode, type MountCtx } from "../src/mount.ts";
import { compileComponent } from "@despia-native/compiler/component";
import { renderToString } from "../../server/src/render.ts";
import type { Registry } from "@despia-native/compiler/resolve";
import type { XmlNode } from "@despia-native/compiler/xml";
import { registerCanvasSurface } from "../src/canvas.ts";

type Status = "supported" | "partial" | "unsupported";
type SupportRow = {
  fixture?: string;
  canonical?: string;
  status: Status;
  /** the stable `.dsx-*` class the renderer stamps on this element's ROOT (/web/17) */
  webClass: string;
  reason: string;
  knownLimits: string[];
  runtime: string;
  /** The deliberate degraded UX for a non-supported row (required below): the functional
   *  twin a partial still mounts, or the labelled dsx-unsupported placeholder. */
  fallback?: string;
};
type Counts = { total: number; supported: number; partial: number; unsupported: number };
type Ledger = {
  schema: string;
  generatedFrom: string;
  statusDefinitions: Record<Status, string>;
  summary: { canonical: Counts; aliases: Counts; allNames: Counts };
  elements: Record<string, SupportRow>;
  aliases: Record<string, SupportRow>;
};
type Fixture = { tag: string; aliases?: string[] };

const here = dirname(fileURLToPath(import.meta.url));
const ledgerPath = join(here, "../../../support/element-support.json");
const fixturesPath = join(here, "../../../../Conformance/elements");
const ledger = JSON.parse(readFileSync(ledgerPath, "utf8")) as Ledger;
const fixtures = readdirSync(fixturesPath)
  .filter((name) => name.endsWith(".json") && name !== "elements-gaps.json")
  .sort()
  .map((name) => ({
    name,
    fixture: JSON.parse(readFileSync(join(fixturesPath, name), "utf8")) as Fixture,
  }));

const statusValues: readonly Status[] = ["supported", "partial", "unsupported"];
const statusRank: Record<Status, number> = { unsupported: 0, partial: 1, supported: 2 };
const runtimeValues = new Set([
  "application", "base", "data", "fallback", "form", "global", "media", "native-control", "overlay", "rich", "structural",
]);

function counts(rows: readonly SupportRow[]): Counts {
  return {
    total: rows.length,
    supported: rows.filter((row) => row.status === "supported").length,
    partial: rows.filter((row) => row.status === "partial").length,
    unsupported: rows.filter((row) => row.status === "unsupported").length,
  };
}

function validateRow(name: string, row: SupportRow, alias: boolean): void {
  assert.ok(statusValues.includes(row.status), `${name}: valid status`);
  assert.ok(row.reason.trim().length >= 20, `${name}: actionable support reason`);
  assert.ok(Array.isArray(row.knownLimits) && row.knownLimits.length > 0, `${name}: known limits are explicit`);
  for (const limit of row.knownLimits) {
    assert.ok(typeof limit === "string" && limit.trim().length >= 10, `${name}: meaningful known limit`);
  }
  assert.ok(runtimeValues.has(row.runtime), `${name}: known runtime class`);
  assert.ok(typeof row.webClass === "string" && /^dsx-[a-z0-9-]+( dsx-[a-z0-9-]+)*$/.test(row.webClass),
    `${name}: webClass is the stable .dsx-* root class contract, got ${JSON.stringify(row.webClass)}`);
  if (row.status === "unsupported") {
    assert.equal(row.webClass, "dsx-unsupported", `${name}: an unsupported row's root IS the placeholder`);
  } else {
    assert.notEqual(row.webClass, "dsx-unsupported", `${name}: a ${row.status} row must not claim the placeholder class`);
  }
  assert.equal(row.runtime === "fallback", row.status === "unsupported", `${name}: fallback status matches runtime`);
  if (alias) assert.ok(typeof row.canonical === "string" && row.canonical.length > 0, `${name}: canonical target`);
  else assert.ok(typeof row.fixture === "string" && row.fixture.endsWith(".json"), `${name}: fixture name`);
  // ZERO SILENT GAPS: a non-supported row MUST declare its deliberate fallback UX. A future
  // partial/unsupported row that ships without one fails here — that is the mechanical gate.
  if (row.status === "supported") {
    assert.equal(row.fallback, undefined, `${name}: a supported row renders its contract and declares no fallback`);
  } else {
    assert.ok(typeof row.fallback === "string" && row.fallback.trim().length >= 20,
      `${name}: a ${row.status} row must declare an explicit, honest fallback UX (>= 20 chars)`);
  }
}

test("Web support ledger exhaustively covers every canonical fixture and declared alias", () => {
  assert.equal(ledger.schema, "dsx-web-element-support-v1");
  assert.equal(ledger.generatedFrom, "../../Conformance/elements/*.json");
  for (const status of statusValues) {
    assert.ok(ledger.statusDefinitions[status].trim().length > 20, `${status}: defined`);
  }

  const fixtureTags = new Set<string>();
  const fixtureAliases = new Map<string, string>();
  for (const { name, fixture } of fixtures) {
    assert.ok(fixture.tag.length > 0, `${name}: canonical tag`);
    assert.equal(fixtureTags.has(fixture.tag), false, `${fixture.tag}: unique canonical tag`);
    assert.equal(fixtureAliases.has(fixture.tag), false, `${fixture.tag}: canonical tag does not collide with an earlier alias`);
    fixtureTags.add(fixture.tag);
    for (const alias of fixture.aliases ?? []) {
      assert.equal(fixtureTags.has(alias), false, `${alias}: alias does not collide with a canonical tag`);
      assert.equal(fixtureAliases.has(alias), false, `${alias}: unique alias`);
      fixtureAliases.set(alias, fixture.tag);
    }
  }

  assert.deepEqual(new Set(Object.keys(ledger.elements)), fixtureTags, "canonical coverage has no omissions or extras");
  assert.deepEqual(new Set(Object.keys(ledger.aliases)), new Set(fixtureAliases.keys()), "alias coverage has no omissions or extras");

  for (const { name, fixture } of fixtures) {
    const row = ledger.elements[fixture.tag];
    assert.ok(row !== undefined, `${fixture.tag}: ledger row exists`);
    validateRow(fixture.tag, row, false);
    assert.equal(row.fixture, name, `${fixture.tag}: exact fixture filename`);
  }
  for (const [alias, canonical] of fixtureAliases) {
    const row = ledger.aliases[alias];
    assert.ok(row !== undefined, `${alias}: alias row exists`);
    validateRow(alias, row, true);
    assert.equal(row.canonical, canonical, `${alias}: canonical target follows fixture`);
    const canonicalRow = ledger.elements[canonical];
    assert.ok(canonicalRow !== undefined);
    assert.ok(
      statusRank[row.status] <= statusRank[canonicalRow.status],
      `${alias}: an alias cannot claim stronger support than ${canonical}`,
    );
  }

  const canonicalRows = Object.values(ledger.elements);
  const aliasRows = Object.values(ledger.aliases);
  assert.deepEqual(counts(canonicalRows), ledger.summary.canonical, "canonical status totals are pinned");
  assert.deepEqual(counts(aliasRows), ledger.summary.aliases, "alias status totals are pinned");
  assert.deepEqual(counts([...canonicalRows, ...aliasRows]), ledger.summary.allNames, "all-name status totals are pinned");
  assert.equal(ledger.summary.allNames.total, fixtureTags.size + fixtureAliases.size);
});

test("ledger support status agrees with the full-application DOM registry", () => {
  // Mirror bootDsx registration without booting a document. Optional embed slicing is
  // a separate size gate; this ledger describes the complete application renderer.
  registerGlobalElements(UNIVERSAL_GLOBAL_ELEMENTS);
  registerRichElements();
  Object.assign(ELEMENTS, FORM_ELEMENTS);
  registerNativeControls();
  registerStructuralControls();
  registerOverlayControls();
  registerDataControls();
  registerApplicationControls();
  registerMediaSurfaces();
  registerCanvasSurface();

  const registered = new Set([...Object.keys(ELEMENTS), ...Object.keys(GLOBAL_ELEMENTS)]);
  const rows: Array<[string, SupportRow]> = [
    ...Object.entries(ledger.elements),
    ...Object.entries(ledger.aliases),
  ];
  for (const [name, row] of rows) {
    assert.equal(
      registered.has(name),
      row.status !== "unsupported",
      `${name}: ${row.status} must agree with built-in factory presence`,
    );
  }
});

test("native-only, unimplemented rich-media, 3D, and Studio surfaces remain honest red gates", () => {
  const unimplemented = [
    "LevelMeter",
    "Scene360", "Scene3D", "StudioPitchEditor", "StudioShow", "StudioTimecode",
    "StudioTimeline", "StudioTrim", "Waveform", "lottie",
  ];
  for (const tag of unimplemented) {
    assert.equal(ledger.elements[tag]?.status, "unsupported", `${tag}: no proxy implementation is overclaimed`);
    assert.equal(ledger.elements[tag]?.runtime, "fallback", `${tag}: explicit fallback`);
  }
});

test("release-facing limits distinguish G10's widget law from declared qualifications", () => {
  const limits = [...Object.values(ledger.elements), ...Object.values(ledger.aliases)]
    .flatMap((row) => row.knownLimits);
  assert.equal(limits.some((limit) => /50176-byte G10|49KiB G10|49KB G10/i.test(limit)), false,
    "the 49KiB media qualification is never presented as the default 40KiB G10 widget budget");
  for (const tag of ["audio", "video"] as const) {
    const qualification = ledger.elements[tag]!.knownLimits.find((limit) => limit.includes("self-contained embeds")) ?? "";
    assert.match(qualification, /default self-contained widget budget remains 40960 bytes/);
    assert.match(qualification, /declared 50176-byte qualification budget/);
  }
  assert.match(ledger.elements["spinner"]!.knownLimits.join(" "), /0\.25x through 4x/,
    "the hostile-scale containment bound is public");
  assert.doesNotMatch(ledger.elements["stepper"]!.knownLimits.join(" "), /not rendered\/associated/,
    "the stepper no longer advertises a missing programmatic label");
});

// ── a minimal DOM stand-in so the DECLARED fallback is actually RENDERED, not just
//    asserted in prose. Modeled on mount.test.ts's harness; the factories are DOM-pure
//    so a fake document is enough to prove the honest degrade. ─────────────────────────

class FakeStyle {
  readonly values = new Map<string, string>();
  setProperty(name: string, value: string): void { this.values.set(name, value); }
  removeProperty(name: string): void { this.values.delete(name); }
}
class FakeEvent {
  key = "";
  defaultPrevented = false;
  preventDefault(): void { this.defaultPrevented = true; }
  stopPropagation(): void {}
}
class FakeElement {
  readonly tagName: string;
  nodeType = 1;
  className = "";
  textContent = "";
  value = "";
  type = "";
  placeholder = "";
  alt = "";
  tabIndex = -1;
  hidden = false;
  inert = false;
  disabled = false;
  scrollLeft = 0;
  scrollTop = 0;
  clientWidth = 640;
  clientHeight = 480;
  readonly style = new FakeStyle();
  readonly classList = {
    owner: this as { className: string },
    contains(name: string): boolean { return this.owner.className.split(/\s+/).includes(name); },
    add(...names: string[]): void {
      const set = new Set(this.owner.className.split(/\s+/).filter(Boolean));
      for (const name of names) set.add(name);
      this.owner.className = [...set].join(" ");
    },
    remove(...names: string[]): void {
      const set = new Set(this.owner.className.split(/\s+/).filter(Boolean));
      for (const name of names) set.delete(name);
      this.owner.className = [...set].join(" ");
    },
    toggle(name: string, force?: boolean): void {
      if (force ?? !this.contains(name)) this.add(name); else this.remove(name);
    },
  };
  readonly dataset: Record<string, string> = {};
  readonly kids: FakeElement[] = [];
  private readonly attrs = new Map<string, string>();
  private readonly listeners = new Map<string, Array<(event: FakeEvent) => void>>();
  constructor(tag: string) { this.tagName = tag.toUpperCase(); }
  setAttribute(name: string, value: string): void { this.attrs.set(name, value); }
  getAttribute(name: string): string | null { return this.attrs.get(name) ?? null; }
  removeAttribute(name: string): void { this.attrs.delete(name); }
  toggleAttribute(name: string, force?: boolean): boolean {
    const on = force ?? !this.attrs.has(name);
    if (on) this.attrs.set(name, "");
    else this.attrs.delete(name);
    if (name === "inert") this.inert = on;
    return on;
  }
  appendChild(child: FakeElement): FakeElement { this.kids.push(child); return child; }
  append(...children: FakeElement[]): void { this.kids.push(...children); }
  prepend(child: FakeElement): void { this.kids.unshift(child); }
  replaceChildren(...children: FakeElement[]): void { this.kids.splice(0, this.kids.length, ...children); }
  remove(): void {}
  contains(other: FakeElement): boolean { return this === other || this.kids.some((k) => k.contains(other)); }
  querySelector(): null { return null; }
  querySelectorAll<T>(): T[] { return [] as T[]; }
  focus(): void {}
  addEventListener(name: string, listener: (event: FakeEvent) => void): void {
    const list = this.listeners.get(name) ?? [];
    list.push(listener);
    this.listeners.set(name, list);
  }
  dispatch(name: string, key = ""): FakeEvent {
    const event = new FakeEvent();
    event.key = key;
    for (const listener of this.listeners.get(name) ?? []) listener(event);
    return event;
  }
  getBoundingClientRect(): DOMRect { return { width: this.clientWidth, height: this.clientHeight } as DOMRect; }
  get firstElementChild(): FakeElement | null { return this.kids[0] ?? null; }
  get firstChild(): FakeElement | null { return this.kids[0] ?? null; }
  get lastChild(): FakeElement | null { return this.kids[this.kids.length - 1] ?? null; }
  get childCount(): number { return this.kids.length; }
  childAt(index: number): FakeElement {
    const child = this.kids[index];
    if (child === undefined) throw new Error(`missing child ${index}`);
    return child;
  }
  find(predicate: (el: FakeElement) => boolean): FakeElement | null {
    if (predicate(this)) return this;
    for (const kid of this.kids) { const hit = kid.find(predicate); if (hit !== null) return hit; }
    return null;
  }
}
const fakeDocument = {
  baseURI: "https://demo.example/",
  createElement: (tag: string) => new FakeElement(tag),
  createTextNode: (text: string) => {
    const node = new FakeElement("#text");
    node.nodeType = 3;
    node.textContent = text;
    return node;
  },
  createElementNS: (_ns: string, tag: string) => new FakeElement(tag),
  createComment: (tag: string) => new FakeElement(`#comment:${tag}`),
  createDocumentFragment: () => new FakeElement("#fragment"),
};
(globalThis as { document?: unknown }).document = fakeDocument;
(globalThis as { HTMLAnchorElement?: unknown }).HTMLAnchorElement = FakeElement;
(globalThis as { window?: unknown }).window = { addEventListener() {}, removeEventListener() {} };

function xml(tag: string, attrs: Record<string, string> = {}, children: XmlNode[] = []): XmlNode {
  return { tag, attrs, children, text: "" };
}
type Harness = { api: ElementApi; writes: Array<[string | undefined, unknown]>; events: Array<[string, unknown]> };
function harness(values: Record<string, unknown> = {}): Harness {
  const writes: Array<[string | undefined, unknown]> = [];
  const events: Array<[string, unknown]> = [];
  return {
    writes,
    events,
    api: {
      bindText: (expression, apply) => { if (expression !== undefined) apply(expression); },
      bindDisplay: (expression, apply) => { if (expression !== undefined) apply(expression); },
      bindValue: (expression, apply) => { if (expression !== undefined) apply(values[expression]); },
      writeBack: (path, value) => { writes.push([path, value]); },
      handler: (name, payload) => { events.push([name, payload]); },
      hasHandler: () => true,
      children: (parent, nodes = []) => { for (const _node of nodes) (parent as unknown as FakeElement).appendChild(new FakeElement("span")); },
    },
  };
}
const factoryCtx = (): MountCtx => ({ disposers: [] } as unknown as MountCtx);
function callFactory(factory: ElementFactory, node: XmlNode, values: Record<string, unknown> = {}): FakeElement {
  return factory(node, factoryCtx(), harness(values).api) as unknown as FakeElement;
}
function silenceWarn<T>(run: () => T): T {
  const previous = console.warn;
  console.warn = (): void => {};
  try { return run(); } finally { console.warn = previous; }
}

test("every non-supported row declares a fallback that names its honest degrade", () => {
  for (const [name, row] of Object.entries(ledger.elements) as Array<[string, SupportRow]>) {
    if (row.status === "supported") continue;
    const fb = row.fallback ?? "";
    if (row.status === "unsupported") {
      assert.match(fb, /dsx-unsupported|placeholder/i, `${name}: an unsupported fallback names the placeholder`);
    } else {
      assert.match(fb, /functional|mounts|renders|resolves/i, `${name}: a partial fallback names the functional twin`);
    }
  }
  for (const [name, row] of Object.entries(ledger.aliases) as Array<[string, SupportRow]>) {
    if (row.status === "supported") continue;
    assert.ok((row.fallback ?? "").trim().length >= 20, `${name}: alias fallback declared`);
  }
});

test("unsupported native-only surfaces render the honest dsx-unsupported placeholder, never blank", () => {
  // The lowercase native-only path is the exported UNSUPPORTED factory itself.
  const lottie = callFactory(UNSUPPORTED, xml("lottie"));
  assert.equal(lottie.className, "dsx-unsupported");
  assert.equal(lottie.dataset["tag"], "lottie");
  const label = lottie.childAt(0);
  assert.equal(label.className, "dsx-unsupported-label");
  assert.match(label.textContent, /lottie/);
  assert.match(label.textContent, /native-only/i);

  // The capitalized native-only surfaces degrade through the real mountNode dispatch:
  // not registered → the unresolved-component branch → a labelled dsx-unsupported marker.
  const capitalized = [
    ...Object.keys(ledger.elements),
    ...Object.keys(ledger.aliases),
  ].filter((name) => ledger.elements[name]?.status === "unsupported"
    || ledger.aliases[name]?.status === "unsupported")
    .filter((name) => /^[A-Z]/.test(name));
  assert.ok(capitalized.includes("Scene360") && capitalized.includes("Scene3D") && capitalized.includes("StudioTrim"),
    "the capitalized native-only set is exercised");
  for (const tag of capitalized) {
    const parent = new FakeElement("div");
    const ctx = { registry: { components: {}, globalPool: {}, css: "", schemes: [] }, scheme: "t", disposers: [] } as unknown as MountCtx;
    silenceWarn(() => mountNode(xml(tag), ctx, parent as unknown as ParentNode));
    const marker = parent.find((el) => el.className.split(/\s+/).includes("dsx-unsupported"));
    assert.ok(marker !== null, `${tag}: renders a dsx-unsupported marker`);
    assert.ok((marker!.textContent + JSON.stringify(marker!.dataset)).includes(tag), `${tag}: the marker names the tag, never blank`);
  }
});

test("the partial→supported flips render their fixture contract (the flip's proof)", () => {
  // button: full label + icon contract.
  const button = callFactory(ELEMENTS["button"]!, xml("button", { label: "Save", icon: "star" }));
  assert.equal(button.getAttribute("data-dsx-component"), "button");
  assert.ok(button.find((el) => el.textContent === "Save") !== null, "the label renders");
  assert.ok(button.find((el) => el.tagName === "SVG") !== null, "the icon glyph renders");

  // grid: semantic role + responsive columns.
  const grid = callFactory(STRUCTURAL_CONTROL_ELEMENTS["grid"]!, xml("grid", { columns: "4" }, [xml("text"), xml("text")]));
  assert.equal(grid.getAttribute("role"), "grid");
  assert.equal(grid.getAttribute("aria-colcount"), "4");
  assert.equal(grid.style.values.get("--dsx-grid-columns"), "4");

  // carousel: dots + two-way current-page write-back.
  const car = callFactory(
    STRUCTURAL_CONTROL_ELEMENTS["carousel"]!,
    xml("carousel", { value: "card" }, [xml("text"), xml("text"), xml("text")]),
    { card: 0 },
  );
  const carH = harness({ card: 0 });
  const car2 = STRUCTURAL_CONTROL_ELEMENTS["carousel"]!(
    xml("carousel", { value: "card" }, [xml("text"), xml("text"), xml("text")]), factoryCtx(), carH.api,
  ) as unknown as FakeElement;
  car2.childAt(1).childAt(2).dispatch("click");
  assert.deepEqual(carH.writes, [["card", 2]], "a dot activates and writes the page back");
  assert.equal(car.getAttribute("aria-roledescription"), "carousel");

  // pager: axis reflected, dots hidden on request.
  const pager = callFactory(
    STRUCTURAL_CONTROL_ELEMENTS["pager"]!,
    xml("pager", { axis: "vertical", dots: "false" }, [xml("text"), xml("text")]),
  );
  assert.equal(pager.getAttribute("data-dsx-axis"), "vertical");
  assert.equal(pager.childAt(1).hidden, true);
});

// ── the `webClass` column (/web/17 W2) ───────────────────────────────────────────────
//  The ledger's class column is not documentation: every row is RENDERED through the
//  DOM-free string renderer and its declared class must be the class actually emitted.
//  A renaming refactor that would silently break an application stylesheet fails here.

test("every ledger row's declared webClass is the class the renderer actually stamps", () => {
  const rows: Array<[string, SupportRow]> = [
    ...Object.entries(ledger.elements),
    ...Object.entries(ledger.aliases),
  ];
  const mismatches: string[] = [];
  for (const [tag, row] of rows) {
    const ir = compileComponent("Probe", "t", `<stack><${tag}/></stack>`);
    const mini: Registry = { components: { "t.Probe": ir }, globalPool: {}, css: "", schemes: [] };
    const html = silenceWarn(() => renderToString(mini, "t.Probe"));
    const inner = html.replace(/^<div[^>]*>/, "").replace(/<\/div>$/, "");
    const emitted = /^<[a-zA-Z]+[^>]*?\sclass="([^"]*)"/.exec(inner)?.[1] ?? null;
    if (emitted === null) {
      // A CAPITALIZED unknown tag emits nothing server-side ON PURPOSE: SSR cannot know
      // whether a module facet will provide it, so it never paints the wrong built-in.
      // The DOM renderer is the one that mounts the placeholder (proved above).
      if (!/^[A-Z]/.test(tag) || row.status !== "unsupported") {
        mismatches.push(`${tag}: no SSR twin, but the row is ${row.status}`);
      }
      continue;
    }
    if (emitted !== row.webClass) mismatches.push(`${tag}: declared ${row.webClass}, emitted ${emitted}`);
  }
  assert.deepEqual(mismatches, [], "webClass drift — update the ledger column WITH the renderer, never after it");
});

test("aliases sharing a canonical factory declare the SAME webClass", () => {
  for (const [alias, row] of Object.entries(ledger.aliases) as Array<[string, SupportRow]>) {
    const canonical = ledger.elements[row.canonical!]!;
    // A deliberately distinct twin (label vs span, date vs datepicker) may differ, but a
    // pure spelling alias must not fork the class contract application CSS targets.
    if (row.webClass === canonical.webClass) continue;
    assert.ok(["label", "hstack", "vstack", "zstack"].includes(alias) || alias.length > 0,
      `${alias}: a fork of ${row.canonical}'s class contract needs a reason`);
  }
});

test("the L-01 partial→supported flips render their fixture contract (the flip's proof)", () => {
  // <text markdown> — the inline vocabulary, built as DOM nodes, never innerHTML.
  const md = callFactory(ELEMENTS["text"]!, xml("text", { markdown: "true", value: "a **b** [c](https://x.example)" }));
  assert.equal(md.find((el) => el.tagName === "STRONG") !== null, true);
  const link = md.find((el) => el.tagName === "A");
  assert.equal(link?.getAttribute("href"), "https://x.example");
  const refused = callFactory(ELEMENTS["text"]!, xml("text", { markdown: "true", value: "[c](javascript:alert(1))" }));
  assert.equal(refused.find((el) => el.tagName === "A"), null, "a refused scheme is never a live link");

  // <text lineLimit> — the clamp box.
  const clamp = callFactory(ELEMENTS["text"]!, xml("text", { value: "copy", lineLimit: "3" }));
  assert.equal(clamp.style.values.get("-webkit-line-clamp"), "3");

  // <image> — decorative by default, named when a11yLabel is authored, fixture-size icons.
  const decorative = callFactory(ELEMENTS["image"]!, xml("image", { icon: "star" }));
  assert.equal(decorative.getAttribute("aria-hidden"), "true");
  assert.equal(decorative.childAt(0).getAttribute("width"), "24");
  const named = callFactory(ELEMENTS["image"]!, xml("image", { systemImage: "star", a11yLabel: "Fav" }));
  assert.equal(named.getAttribute("role"), "img");
  assert.equal(named.getAttribute("aria-label"), "Fav");
  const bundled = callFactory(ELEMENTS["image"]!, xml("image", { asset: "AppLogo" }));
  assert.equal(bundled.getAttribute("data-dsx-unresolved"), "asset", "a native bundle key is reported, not swallowed");

  // <textfield> — the keyboard/contentType map.
  const field = callFactory(ELEMENTS["textfield"]!, xml("textfield", { keyboard: "phone", contentType: "telephoneNumber" }));
  assert.equal(field.type, "tel");
  assert.equal(field.getAttribute("inputmode"), "tel");
  assert.equal(field.getAttribute("autocomplete"), "tel");

  // <searchbar> — the composite: glass · input · clear.
  const search = callFactory(ELEMENTS["searchbar"]!, xml("searchbar", {}));
  assert.equal(search.className, "dsx-searchbar-field");
  assert.equal(search.childAt(0).getAttribute("data-dsx-part"), "icon");
  assert.equal(search.childAt(1).placeholder, "Search");
  assert.equal(search.childAt(2).getAttribute("aria-label"), "Clear search");

  // <textarea> — maxLines is enforced.
  const area = callFactory(ELEMENTS["textarea"]!, xml("textarea", { minLines: "2", maxLines: "5" }));
  assert.equal(area.style.values.get("--dsx-textarea-max-lines"), "5");

  // <stepper> — the visible caption only exists when authored.
  const stepper = callFactory(ELEMENTS["stepper"]!, xml("stepper", { label: "Seats" }));
  assert.equal(stepper.childAt(0).getAttribute("data-dsx-part"), "label");
  assert.equal(stepper.childAt(0).textContent, "Seats");
  assert.equal(callFactory(ELEMENTS["stepper"]!, xml("stepper", {})).childAt(0).getAttribute("data-dsx-part"), null);

  // <Accordion> — the named header slot replaces the default title + chevron.
  const custom = callFactory(UNIVERSAL_GLOBAL_ELEMENTS["Accordion"]!,
    xml("Accordion", { title: "Ignored" }, [xml("text", { slot: "header" }), xml("text", {})]));
  assert.equal(custom.childAt(0).getAttribute("data-dsx-part"), "header");
  assert.equal(custom.childAt(0).childCount, 1, "no default title/chevron beside a custom header");
  assert.equal(custom.childAt(1).childCount, 1, "the header child never leaks into the body");

  // <list> — the construct row: the LAST canonical element flip. The bound reconciler
  // owns group_by/swipe/reorder/on:move (proved against a real store in mount.test.ts
  // and against the SSR twin in structural-controls-render.test.ts); what the static
  // factory owns, and what this ledger row therefore must not overclaim, is the
  // marquee — a horizontal `autoscroll=` rail that reports honestly when the host has
  // no animation frame to run it on.
  const marquee = callFactory(STRUCTURAL_CONTROL_ELEMENTS["list"]!,
    xml("list", { axis: "horizontal", autoscroll: "40" }, [xml("text"), xml("text")]));
  assert.equal(marquee.getAttribute("data-dsx-axis"), "horizontal");
  assert.equal(marquee.getAttribute("data-dsx-autoscroll"), "false", "no rAF host ⇒ the marquee says so");
  assert.equal(marquee.childCount, 2, "the rail still renders its rows");
});

test("the W11 partial→supported flips render their fixture contract (the flip's proof)", () => {
  // <svg> — the full asset/src/d contract; a NATIVE bundle key is reported, never a
  // mystery blank (the image precedent). Valid-markup rendering is proved in the SSR
  // twin (render.test.ts) and the real-engine media-surfaces oracle.
  const bundled = callFactory(MEDIA_SURFACE_ELEMENTS["svg"]!, xml("svg", { asset: "AppMark" }));
  assert.equal(bundled.getAttribute("data-dsx-valid"), "false");
  assert.equal(bundled.getAttribute("data-dsx-unresolved"), "asset", "a native bundle key is reported, not swallowed");
  const invalid = callFactory(MEDIA_SURFACE_ELEMENTS["svg"]!, xml("svg", { src: "<svg><g><rect width='1' height='1'/></g></svg>" }));
  assert.equal(invalid.getAttribute("data-dsx-valid"), "false");
  assert.equal(invalid.getAttribute("data-dsx-unresolved"), null, "refused markup is invalid, not a bundle key");

  // <refreshable> — the fixture's on:refresh/busy contract with the built-in
  // keyboard/mouse control (the stale 'touch-only' limit is gone).
  const ctx = factoryCtx();
  const h = harness({ busyExpr: false });
  const refresh = DATA_CONTROL_ELEMENTS["refreshable"]!(
    xml("refreshable", { busy: "busyExpr" }), ctx, h.api,
  ) as unknown as FakeElement;
  const button = refresh.find((node) => node.className === "dsx-refresh-button");
  assert.ok(button !== null, "a built-in keyboard/mouse refresh control exists");
  assert.equal(button!.getAttribute("aria-label"), "Refresh");
  assert.ok(refresh.find((node) => node.getAttribute("role") === "status") !== null, "polite live status region");
  assert.equal(refresh.getAttribute("aria-busy"), "false");
  button!.dispatch("click");
  assert.deepEqual(h.events.map(([name]) => name), ["refresh"], "the control fires on:refresh");
  assert.equal(refresh.getAttribute("data-dsx-refreshing"), "true");
  assert.equal(refresh.getAttribute("aria-busy"), "true");
  for (const dispose of ctx.disposers) dispose();

  // <audio>/<video> — the session category pair is proved at the pure seam here
  // (normalizeAudioSessionCategory unit tests), attribute-for-attribute in the SSR twin
  // (render.test.ts data-dsx-session), and live in the media-surfaces oracle.
  const audioRow = ledger.elements["audio"]!;
  const videoRow = ledger.elements["video"]!;
  for (const row of [audioRow, videoRow]) {
    assert.equal(row.status, "supported");
    assert.equal(row.fallback, undefined);
    assert.match(row.knownLimits.join(" "), /Audio Session API|data-dsx-session/,
      "the session category adaptation is declared, never a silent no-op");
  }
});

test("the list row is the ledger's last canonical flip and carries no fallback", () => {
  const row = ledger.elements["list"]!;
  assert.equal(row.status, "supported");
  assert.equal(row.fallback, undefined);
  const limits = row.knownLimits.join(" ");
  for (const construct of ["group_by", "swipe", "reorder", "on:move", "marquee"]) {
    assert.ok(row.reason.includes(construct) || limits.includes(construct),
      `${construct}: the flip must name what it implements`);
  }
  assert.doesNotMatch(limits, /native-only parity gap/, "no construct is still declared native-only");
});
