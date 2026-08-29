// Semantic and data-plane gates for the opt-in DSX browser-native controls.

import { test } from "node:test";
import assert from "node:assert/strict";

import type { XmlNode } from "@despia/compiler/xml";
import type { MountCtx } from "../src/mount.ts";
import {
  NATIVE_CONTROL_ELEMENTS,
  NATIVE_CONTROL_OPTION_LIMIT,
  NATIVE_CONTROL_TAGS,
  NATIVE_CONTROLS_CSS,
  OTP_LENGTH_LIMIT,
  datePickerWireValue,
  isoDatePickerValue,
  normalizeDatePickerMode,
  normalizeNativeControlOptions,
  normalizeOtpLength,
  normalizeOtpValue,
  normalizeRangeBounds,
  parseNativeControlCsv,
  registerNativeControls,
} from "../src/native-controls.ts";
import { ELEMENTS, type ElementApi } from "../src/elements.ts";

class FakeStyle {
  readonly values = new Map<string, string>();
  setProperty(name: string, value: string): void { this.values.set(name, value); }
  removeProperty(name: string): void { this.values.delete(name); }
}

class FakeElement {
  readonly tagName: string;
  className = "";
  textContent = "";
  type = "";
  value = "";
  size = 0;
  tabIndex = 0;
  hidden = false;
  disabled = false;
  id = "";
  autocomplete = "";
  inputMode = "";
  pattern = "";
  min = "";
  max = "";
  step = "";
  selectedIndex = -1;
  placeholder = "";
  readonly style = new FakeStyle();
  readonly dataset: Record<string, string> = {};
  private readonly attrs = new Map<string, string>();
  private children: FakeElement[] = [];
  private readonly listeners = new Map<string, Array<(event: FakeEvent) => void>>();

  constructor(tag: string) { this.tagName = tag.toUpperCase(); }
  setAttribute(name: string, value: string): void { this.attrs.set(name, value); }
  getAttribute(name: string): string | null { return this.attrs.get(name) ?? null; }
  removeAttribute(name: string): void { this.attrs.delete(name); }
  appendChild(child: FakeElement): FakeElement { this.children.push(child); return child; }
  append(...children: FakeElement[]): void { this.children.push(...children); }
  replaceChildren(...children: FakeElement[]): void { this.children = children; }
  addEventListener(name: string, listener: (event: FakeEvent) => void): void {
    const listeners = this.listeners.get(name) ?? [];
    listeners.push(listener);
    this.listeners.set(name, listeners);
  }
  dispatch(name: string, init: Partial<FakeEvent> = {}): FakeEvent {
    const event = Object.assign(new FakeEvent(name), init);
    for (const listener of this.listeners.get(name) ?? []) listener(event);
    return event;
  }
  focus(): void { this.dispatch("focus"); }
  blur(): void { this.dispatch("blur"); }
  scrollIntoView(): void {}
  querySelectorAll<T>(): T[] {
    const found: FakeElement[] = [];
    const visit = (node: FakeElement): void => {
      if (node.getAttribute("role") === "option") found.push(node);
      for (const child of node.children) visit(child);
    };
    for (const child of this.children) visit(child);
    return found as T[];
  }
  childAt(index: number): FakeElement {
    const child = this.children[index];
    if (child === undefined) throw new Error(`missing child ${index}`);
    return child;
  }
  get childCount(): number { return this.children.length; }
}

class FakeEvent {
  readonly type: string;
  key = "";
  defaultPrevented = false;
  constructor(type: string) { this.type = type; }
  preventDefault(): void { this.defaultPrevented = true; }
}

(globalThis as { document?: unknown }).document = {
  createElement: (tag: string) => new FakeElement(tag),
  createElementNS: (_ns: string, tag: string) => new FakeElement(tag),
};

type ApiHarness = {
  api: ElementApi;
  writes: Array<[string | undefined, unknown]>;
  events: Array<[string, unknown]>;
};

function harness(values: Record<string, unknown> = {}): ApiHarness {
  const writes: Array<[string | undefined, unknown]> = [];
  const events: Array<[string, unknown]> = [];
  return {
    writes,
    events,
    api: {
      bindText: (expression, apply) => { if (expression !== undefined) apply(expression); },
      bindDisplay: (expression, apply) => { if (expression !== undefined) apply(expression); },
      bindValue: (expression, apply) => { if (expression !== undefined) apply(values[expression]); },
      writeBack: (path, value) => { writes.push([path, value]); values[path ?? ""] = value; },
      handler: (name, payload) => { events.push([name, payload]); },
      hasHandler: () => true,
      children: () => {},
    },
  };
}

function makeNode(tag: string, attrs: Record<string, string>): XmlNode {
  return { tag, attrs, children: [], text: "" };
}

test("native controls stay opt-in, then register every canonical tag and date alias", () => {
  for (const tag of NATIVE_CONTROL_TAGS) assert.equal(ELEMENTS[tag], undefined, `${tag} starts outside the base floor`);
  registerNativeControls();
  for (const tag of ["picker", "datepicker", "date", "combobox", "otp", "rangeslider", "wheelpicker"]) {
    assert.equal(typeof ELEMENTS[tag], "function", `${tag} has a semantic browser factory`);
    assert.equal(NATIVE_CONTROL_TAGS.has(tag), true);
  }
  assert.equal(NATIVE_CONTROL_ELEMENTS["date"], NATIVE_CONTROL_ELEMENTS["datepicker"]);
});

test("picker option grammar matches native String IDs and bounds hostile lists", () => {
  assert.deepEqual(parseNativeControlCsv("Weekly, Monthly,,Yearly"), [
    { value: "Weekly", label: "Weekly" },
    { value: "Monthly", label: "Monthly" },
    { value: "Yearly", label: "Yearly" },
  ]);
  assert.deepEqual(normalizeNativeControlOptions([
    { key: 7, title: "Seven" },
    false,
  ], "key", "title"), [
    { value: "7", label: "Seven" },
    { value: "0", label: "0" },
  ]);
  const hostile = normalizeNativeControlOptions(Array.from({ length: NATIVE_CONTROL_OPTION_LIMIT + 50 }, (_, i) => i));
  assert.equal(hostile.length, NATIVE_CONTROL_OPTION_LIMIT);
});

test("picker and wheelpicker emit real selects with two-way writes and accessible labels", () => {
  for (const tag of ["picker", "wheelpicker"] as const) {
    const h = harness({ plan: "Monthly" });
    const root = NATIVE_CONTROL_ELEMENTS[tag]!(
      makeNode(tag, { bind: "plan", options: "Weekly,Monthly,Yearly", label: "Plan" }),
      { disposers: [] } as unknown as MountCtx,
      h.api,
    ) as unknown as FakeElement;
    const select = root.childAt(0);
    assert.equal(root.tagName, "LABEL");
    assert.equal(select.tagName, "SELECT");
    assert.equal(select.getAttribute("aria-label"), "Plan");
    assert.equal(select.childCount, 3);
    assert.equal(select.selectedIndex, 1);
    if (tag === "wheelpicker") assert.equal(select.size, 5);
    select.value = "Yearly";
    select.dispatch("change");
    assert.deepEqual(h.writes, [["plan", "Yearly"]]);
    assert.deepEqual(h.events, [["change", { value: "Yearly" }]]);
  }
});

test("datepicker uses deterministic UTC ISO seconds and rejects normalized hostile dates", () => {
  const now = new Date("2026-07-23T12:34:56Z");
  assert.equal(normalizeDatePickerMode("wat"), "date");
  assert.equal(normalizeDatePickerMode("datetime"), "datetime");
  assert.equal(isoDatePickerValue("2026-01-02T03:04:05Z", "date", now), "2026-01-02");
  assert.equal(isoDatePickerValue("2026-01-02T03:04:05Z", "time", now), "03:04");
  assert.equal(datePickerWireValue("2026-12-31", "date", null, now), "2026-12-31T00:00:00Z");
  assert.equal(datePickerWireValue("09:45", "time", "2026-01-02T03:04:05Z", now), "2026-01-02T09:45:00Z");
  assert.equal(datePickerWireValue("2026-02-31", "date", null, now), null);
  assert.equal(datePickerWireValue("99:99", "time", null, now), null);
});

test("OTP clamps Unicode digits, bounds allocations and fires complete through one semantic input", () => {
  assert.equal(normalizeOtpLength(Infinity), 6);
  assert.equal(normalizeOtpLength(1_000_000), OTP_LENGTH_LIMIT);
  assert.equal(normalizeOtpLength(-5), 1);
  assert.equal(normalizeOtpValue("a1٢b3", 3), "1٢3");

  const h = harness({ code: "" });
  const root = NATIVE_CONTROL_ELEMENTS["otp"]!(
    makeNode("otp", { bind: "code", length: "4", boxSize: "48", "on:complete": "verify()" }),
    { disposers: [] } as unknown as MountCtx,
    h.api,
  ) as unknown as FakeElement;
  const input = root.childAt(0);
  assert.equal(input.tagName, "INPUT");
  assert.equal(input.autocomplete, "one-time-code");
  assert.equal(root.childAt(1).childCount, 4);
  input.value = "1x٢3٤5";
  input.dispatch("input");
  assert.equal(input.value, "1٢3٤");
  assert.deepEqual(h.writes, [["code", "1٢3٤"]]);
  assert.equal(h.events.some(([name]) => name === "complete"), true);
});

test("range bounds reject non-finite/negative steps and the factory exposes two range inputs", () => {
  assert.deepEqual(normalizeRangeBounds("100", "0", "5"), { min: 0, max: 100, step: 5, degenerate: false });
  assert.deepEqual(normalizeRangeBounds("NaN", "Infinity", "-2"), { min: 0, max: 1, step: null, degenerate: false });
  assert.deepEqual(normalizeRangeBounds("4", "4", "1"), { min: 4, max: 4, step: 1, degenerate: true });

  const h = harness({ low: 20, high: 80 });
  const ctx = { disposers: [] } as unknown as MountCtx;
  const root = NATIVE_CONTROL_ELEMENTS["rangeslider"]!(
    makeNode("rangeslider", { bindLow: "low", bindHigh: "high", min: "0", max: "100", step: "5" }),
    ctx,
    h.api,
  ) as unknown as FakeElement;
  assert.equal(root.getAttribute("role"), "group");
  const low = root.childAt(2);
  const high = root.childAt(3);
  assert.equal(low.type, "range");
  assert.equal(high.type, "range");
  assert.equal(low.getAttribute("aria-label"), "Lower value");
  assert.equal(high.getAttribute("aria-label"), "Upper value");
  low.value = "90";
  low.dispatch("input");
  low.dispatch("change");
  assert.equal(h.writes.at(-1)?.[1], 80, "the low thumb cannot cross the high thumb");
  for (const dispose of ctx.disposers) dispose();
});

test("the combobox search field carries the clear affordance: filled-only, the change contract, Escape layering", () => {
  const h = harness({ city: "Ber" });
  const ctx = { disposers: [] } as unknown as MountCtx;
  const root = NATIVE_CONTROL_ELEMENTS["combobox"]!(
    makeNode("combobox", { bind: "city", options: "Berlin,Bern,Paris" }),
    ctx,
    h.api,
  ) as unknown as FakeElement;
  const input = root.childAt(0);
  const clear = root.childAt(1);
  const list = root.childAt(2);
  assert.equal(input.tagName, "INPUT");
  assert.equal(clear.tagName, "BUTTON");
  assert.equal(list.getAttribute("role"), "listbox");
  assert.equal(clear.type, "button");
  assert.equal(clear.getAttribute("aria-label"), "Clear search");
  assert.equal(clear.getAttribute("data-dsx-part"), "clear");
  assert.equal(clear.childAt(0).tagName, "SVG", "the glyph is drawn chrome, not an icon-corpus lookup");
  assert.equal(clear.hidden, false, "a bound non-empty value shows the affordance");

  clear.dispatch("click");
  assert.equal(input.value, "", "activating the clear empties the field");
  assert.equal(clear.hidden, true, "an empty field hides the affordance");
  assert.deepEqual(h.writes, [["city", ""]], "clearing writes back through the bind path");
  assert.deepEqual(h.events, [["change", { value: "" }]], "clearing rides the same change contract as typing");

  input.value = "Ber";
  input.dispatch("input");
  assert.equal(clear.hidden, false, "typing refills the affordance");
  assert.equal(list.hidden, false, "the refocused field filters and opens");
  input.dispatch("keydown", { key: "Escape" });
  assert.equal(list.hidden, true, "the first Escape closes the list");
  assert.equal(input.value, "Ber", "the first Escape keeps the value");
  input.dispatch("keydown", { key: "Escape" });
  assert.equal(input.value, "", "Escape with the list closed clears the field");
  assert.equal(clear.hidden, true);
  assert.deepEqual(h.writes, [["city", ""], ["city", "Ber"], ["city", ""]]);
});

test("the clear affordance's presentation: absolute trailing, expanded hit box, disabled-gated", () => {
  const start = NATIVE_CONTROLS_CSS.indexOf(".dsx-combobox-clear {");
  assert.ok(start >= 0);
  const body = NATIVE_CONTROLS_CSS.slice(start, NATIVE_CONTROLS_CSS.indexOf("}", start));
  assert.ok(body.includes("position: absolute"), "the affordance floats at the trailing edge");
  assert.ok(body.includes("inset-inline-end"), "trailing is logical, so RTL mirrors for free");
  assert.ok(body.includes("padding: 0.5rem"), "the padded hit box expands well past the 17px glyph");
  assert.ok(NATIVE_CONTROLS_CSS.includes(".dsx-combobox-clear[hidden] { display: none; }"));
  assert.ok(NATIVE_CONTROLS_CSS.includes(".dsx-combobox-input:disabled ~ .dsx-combobox-clear { display: none; }"),
    "a disabled field never offers the clear");
  assert.ok(NATIVE_CONTROLS_CSS.includes(".dsx-combobox-input { width: 100%; padding-inline-end: 2.25rem;"),
    "the input reserves the trailing lane so text never runs under the glyph");
  assert.match(
    NATIVE_CONTROLS_CSS,
    /\.dsx-combobox-clear:focus-visible \{[\s\S]*?outline: var\(--dsx-focus-ring-width\) solid var\(--dsx-accent\);[\s\S]*?outline-offset: var\(--dsx-focus-ring-offset\);[\s\S]*?\}/,
  );
});

test("crossed programmatic range bindings use the same low-first ordering as native and SSR", () => {
  const h = harness({ low: 90, high: 80 });
  const ctx = { disposers: [] } as unknown as MountCtx;
  const root = NATIVE_CONTROL_ELEMENTS["rangeslider"]!(
    makeNode("rangeslider", { bindLow: "low", bindHigh: "high", min: "0", max: "100" }),
    ctx,
    h.api,
  ) as unknown as FakeElement;
  assert.equal(root.style.values.get("--dsx-range-low"), "90%");
  assert.equal(root.style.values.get("--dsx-range-high"), "90%");
  assert.equal(root.childAt(2).getAttribute("aria-valuenow"), "90");
  assert.equal(root.childAt(3).getAttribute("aria-valuenow"), "90");
  for (const dispose of ctx.disposers) dispose();
});

test("native control presentation stays in the weak layer and remains author-overridable", () => {
  assert.ok(NATIVE_CONTROLS_CSS.startsWith("@layer dsx-elements {"));
  for (const selector of [
    ".dsx-picker-select", ".dsx-wheelpicker-select", ".dsx-datepicker-input",
    ".dsx-combobox-input", ".dsx-otp-input", ".dsx-rangeslider-input",
  ]) assert.ok(NATIVE_CONTROLS_CSS.includes(selector), selector);
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(NATIVE_CONTROLS_CSS), "no hard-coded color escapes the token layer");
  assert.ok(!/\brgba?\(/.test(NATIVE_CONTROLS_CSS), "no raw rgb color escapes the token layer");
  assert.ok(NATIVE_CONTROLS_CSS.includes("@media (forced-colors: active)"));
  assert.ok(NATIVE_CONTROLS_CSS.includes("outline: 2px solid Highlight"));
  assert.match(
    NATIVE_CONTROLS_CSS,
    /\.dsx-picker-select, \.dsx-datepicker-input, \.dsx-combobox-input\s*\{[^}]*min-height:\s*44px;/s,
    "mobile native controls expose a real 44px target",
  );
  assert.ok(
    NATIVE_CONTROLS_CSS.includes("@media (min-width: 64rem) and (hover: hover) and (pointer: fine)"),
    "range precision density cannot shrink a narrow viewport",
  );
  assert.match(
    NATIVE_CONTROLS_CSS,
    /@media \(min-width: 64rem\)[\s\S]*?\.dsx-picker-select, \.dsx-datepicker-input, \.dsx-combobox-input\s*\{[^}]*min-height:\s*38px;/,
    "desktop precision native controls retain a 38px visual target",
  );
});

test("native factories only give explicit DSX visual attributes inline precedence", () => {
  const defaults = harness({ plan: "One", code: "" });
  const pickerRoot = NATIVE_CONTROL_ELEMENTS["picker"]!(
    makeNode("picker", { bind: "plan", options: "One,Two" }),
    { disposers: [] } as unknown as MountCtx,
    defaults.api,
  ) as unknown as FakeElement;
  assert.equal(pickerRoot.style.values.has("--dsx-control-tint"), false,
    "the weak CSS accent remains author-overridable when color is absent");

  const otpRoot = NATIVE_CONTROL_ELEMENTS["otp"]!(
    makeNode("otp", { bind: "code" }),
    { disposers: [] } as unknown as MountCtx,
    defaults.api,
  ) as unknown as FakeElement;
  assert.equal(otpRoot.style.values.has("--dsx-otp-box-size"), false,
    "the weak CSS geometry remains author-overridable when boxSize is absent");

  const explicit = harness({ plan: "One", code: "" });
  const authoredPicker = NATIVE_CONTROL_ELEMENTS["picker"]!(
    makeNode("picker", { bind: "plan", options: "One,Two", color: "destructive" }),
    { disposers: [] } as unknown as MountCtx,
    explicit.api,
  ) as unknown as FakeElement;
  assert.equal(authoredPicker.style.values.get("--dsx-control-tint"), "var(--dsx-destructive)");
  const authoredOtp = NATIVE_CONTROL_ELEMENTS["otp"]!(
    makeNode("otp", { bind: "code", boxSize: "60" }),
    { disposers: [] } as unknown as MountCtx,
    explicit.api,
  ) as unknown as FakeElement;
  assert.equal(authoredOtp.style.values.get("--dsx-otp-box-size"), "60px");
});
