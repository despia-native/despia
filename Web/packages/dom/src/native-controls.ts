//
//  native-controls.ts - semantic browser twins for DSX's native input controls.
//  These factories intentionally use real HTML inputs/selects as their interaction
//  surface. The stylesheet only supplies a weak @layer dsx-elements default, so an
//  authored .dsx class/style/theme can replace the look without replacing behavior.
//

import { number, string, truthy } from "@despia-native/kernel";
import type { Dict } from "@despia-native/kernel";
import type { XmlNode } from "@despia-native/compiler/xml";
import { ELEMENTS, SEARCHBAR_GLYPHS, type ElementApi, type ElementFactory } from "./elements.ts";

export type NativeControlOption = { value: string; label: string };

/** Remote options are data, not a DOM allocation budget. The native renderers do
 * not promise unbounded controls; this ceiling keeps a hostile list from freezing
 * the browser while remaining far above a practical picker/listbox. */
export const NATIVE_CONTROL_OPTION_LIMIT = 1_000;
export const NATIVE_CONTROL_TEXT_LIMIT = 2_048;
export const OTP_LENGTH_LIMIT = 32;

let controlSequence = 0;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.className = cls;
  return element;
}

function boundedText(value: unknown): string {
  return string(value).slice(0, NATIVE_CONTROL_TEXT_LIMIT);
}

function finite(value: unknown, fallback: number): number {
  const parsed = number(value);
  return parsed !== null && parsed !== undefined && Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

function sameValue(a: unknown, b: unknown): boolean {
  return Object.is(a, b) || string(a) === string(b);
}

function colorValue(raw: string): string {
  const value = raw.trim();
  const tokens: Readonly<Record<string, string>> = {
    accent: "var(--dsx-accent)",
    label: "var(--dsx-label)",
    secondary: "var(--dsx-secondary-label)",
    tertiary: "var(--dsx-tertiary-label)",
    fill: "var(--dsx-fill)",
    separator: "var(--dsx-separator)",
    destructive: "var(--dsx-destructive)",
    success: "var(--dsx-success)",
    warning: "var(--dsx-warning)",
    danger: "var(--dsx-danger)",
    info: "var(--dsx-info)",
  };
  return (tokens[value] ?? value) || "var(--dsx-accent)";
}

/** The searchbar's circled-x chrome glyph, drawn as a control PART (never an `icon=`
 * token): a chrome affordance must not depend on the cross-runtime icon corpus. */
function clearGlyph(): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "17");
  svg.setAttribute("height", "17");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", SEARCHBAR_GLYPHS.clear);
  svg.appendChild(path);
  return svg;
}

function bindTint(root: HTMLElement, node: XmlNode, api: ElementApi): void {
  // The neutral accent default lives in the weak dsx-elements layer. Only an
  // explicitly authored DSX attribute belongs inline; otherwise an ordinary
  // author stylesheet must remain able to replace --dsx-control-tint.
  const authored = node.attrs["color"];
  if (authored === undefined) return;
  api.bindText(authored, (value) => {
    root.style.setProperty("--dsx-control-tint", colorValue(value));
  });
}

function bindDisabled(
  node: XmlNode,
  api: ElementApi,
  controls: readonly (HTMLInputElement | HTMLSelectElement)[],
  forced = false,
): void {
  let declared = false;
  let conditional = false;
  const apply = (): void => {
    for (const control of controls) control.disabled = forced || declared || conditional;
  };
  if (node.attrs["disabled"] !== undefined) {
    api.bindText(node.attrs["disabled"], (value) => { declared = truthy(value); apply(); });
  }
  if (node.attrs["disabled-if"] !== undefined) {
    api.bindValue(node.attrs["disabled-if"], (value) => { conditional = truthy(value); apply(); });
  }
  apply();
}

/** Picker/combobox/wheel options use String IDs on Swift and Compose. Object rows
 * follow valueField/labelField; scalar rows use the scalar for both. */
export function normalizeNativeControlOptions(
  input: unknown,
  valueField = "id",
  labelField = "label",
): NativeControlOption[] {
  if (!Array.isArray(input)) return [];
  const out: NativeControlOption[] = [];
  const count = Math.min(input.length, NATIVE_CONTROL_OPTION_LIMIT);
  for (let index = 0; index < count; index += 1) {
    const raw = input[index];
    if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
      const row = raw as Record<string, unknown>;
      const value = row[valueField] ?? row[labelField] ?? "";
      out.push({ value: boundedText(value), label: boundedText(row[labelField] ?? value) });
    } else {
      out.push({ value: boundedText(raw), label: boundedText(raw) });
    }
  }
  return out;
}

export function parseNativeControlCsv(csv: string): NativeControlOption[] {
  // Swift String.split omits empty subsequences before trimming. A whitespace-only
  // authored option remains an empty String after trim, matching the native builder.
  return normalizeNativeControlOptions(csv.split(",").filter((part) => part.length > 0).map((part) => part.trim()));
}

function bindOptions(
  node: XmlNode,
  api: ElementApi,
  apply: (options: NativeControlOption[]) => void,
): void {
  const valueField = node.attrs["valueField"] ?? "id";
  const labelField = node.attrs["labelField"] ?? "label";
  if (node.attrs["optionsKey"] !== undefined) {
    api.bindValue(node.attrs["optionsKey"], (value) => {
      apply(normalizeNativeControlOptions(value, valueField, labelField));
    });
  } else {
    api.bindText(node.attrs["options"] ?? "", (value) => apply(parseNativeControlCsv(value)));
  }
}

function emitChanged(api: ElementApi, path: string | undefined, previous: unknown, value: unknown): void {
  if (sameValue(previous, value)) return;
  api.writeBack(path, value);
  api.handler("change", { value } as Dict);
}

function choiceControl(node: XmlNode, api: ElementApi, wheel: boolean): HTMLElement {
  const wrap = el("label", wheel ? "dsx-native-choice dsx-wheelpicker" : "dsx-native-choice dsx-picker");
  const select = el("select", wheel ? "dsx-wheelpicker-select" : "dsx-picker-select");
  if (wheel) select.size = 5;
  wrap.appendChild(select);
  bindTint(wrap, node, api);
  bindDisabled(node, api, [select]);

  let options: NativeControlOption[] = [];
  let selected = "";
  const accessibleLabel = node.attrs["a11yLabel"] ?? node.attrs["label"];
  if (accessibleLabel !== undefined) {
    api.bindText(accessibleLabel, (value) => select.setAttribute("aria-label", value));
  } else {
    select.setAttribute("aria-label", wheel ? "Wheel selection" : "Selection");
  }

  const reflect = (): void => {
    // An unmatched value intentionally leaves the menu unselected, matching SwiftUI.
    select.selectedIndex = options.findIndex((option) => option.value === selected);
  };
  const render = (next: NativeControlOption[]): void => {
    options = next;
    select.replaceChildren(...options.map((option) => {
      const item = document.createElement("option");
      item.value = option.value;
      item.textContent = option.label;
      return item;
    }));
    reflect();
  };
  bindOptions(node, api, render);
  api.bindValue(node.attrs["bind"], (value) => { selected = boundedText(value); reflect(); });
  select.addEventListener("change", () => {
    const next = select.value;
    const previous = selected;
    selected = next;
    emitChanged(api, node.attrs["bind"], previous, next);
  });
  return wrap;
}

export const picker: ElementFactory = (node, _ctx, api) => choiceControl(node, api, false);
export const wheelpicker: ElementFactory = (node, _ctx, api) => choiceControl(node, api, true);

export type DatePickerMode = "date" | "time" | "datetime";

export function normalizeDatePickerMode(value: unknown): DatePickerMode {
  return value === "time" || value === "datetime" ? value : "date";
}

function dateParts(date: Date): { day: string; time: string; datetime: string } {
  const iso = date.toISOString();
  return { day: iso.slice(0, 10), time: iso.slice(11, 16), datetime: iso.slice(0, 16) };
}

export function isoDatePickerValue(value: unknown, mode: DatePickerMode, now = new Date()): string {
  const parsed = typeof value === "string" && value.trim().length > 0 ? new Date(value) : now;
  const safe = Number.isFinite(parsed.getTime()) ? parsed : now;
  const parts = dateParts(safe);
  return mode === "time" ? parts.time : mode === "datetime" ? parts.datetime : parts.day;
}

/** Convert native HTML date fields to the same UTC/seconds wire shape emitted by
 * ISO8601DateFormatter and the Compose twin. */
export function datePickerWireValue(input: string, mode: DatePickerMode, current: unknown, now = new Date()): string | null {
  const baseRaw = typeof current === "string" && current.trim().length > 0 ? new Date(current) : now;
  const base = Number.isFinite(baseRaw.getTime()) ? baseRaw : now;
  let epoch: number;
  if (mode === "date") {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input);
    if (match === null) return null;
    epoch = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 0, 0, 0);
  } else if (mode === "time") {
    const match = /^(\d{2}):(\d{2})$/.exec(input);
    if (match === null) return null;
    epoch = Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), Number(match[1]), Number(match[2]), 0);
  } else {
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(input);
    if (match === null) return null;
    epoch = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), 0);
  }
  if (!Number.isFinite(epoch)) return null;
  const result = new Date(epoch);
  // Date.UTC normalizes invalid dates (Feb 31) rather than rejecting them. Native
  // date inputs should already prevent this, but reject synthetic/hostile events too.
  if (isoDatePickerValue(result.toISOString(), mode, now) !== input) return null;
  return result.toISOString().replace(".000Z", "Z");
}

export const datepicker: ElementFactory = (node, _ctx, api) => {
  const wrap = el("label", "dsx-datepicker");
  const caption = el("span", "dsx-datepicker-label");
  const input = el("input", "dsx-datepicker-input");
  const mode = normalizeDatePickerMode(node.attrs["mode"]);
  input.type = mode === "datetime" ? "datetime-local" : mode;
  input.value = isoDatePickerValue(undefined, mode);
  wrap.append(caption, input);
  bindTint(wrap, node, api);
  bindDisabled(node, api, [input]);
  if (node.attrs["label"] !== undefined) {
    api.bindText(node.attrs["label"], (value) => {
      caption.textContent = value;
      caption.hidden = value.length === 0;
      if (node.attrs["a11yLabel"] === undefined) input.setAttribute("aria-label", value || "Date and time");
    });
    if (node.attrs["a11yLabel"] !== undefined) {
      api.bindText(node.attrs["a11yLabel"], (value) => input.setAttribute("aria-label", value));
    }
  } else {
    caption.hidden = true;
    api.bindText(node.attrs["a11yLabel"] ?? "Date and time", (value) => input.setAttribute("aria-label", value));
  }

  let bound: unknown = undefined;
  api.bindValue(node.attrs["bind"], (value) => {
    bound = value;
    const reflected = isoDatePickerValue(value, mode);
    if (input.value !== reflected) input.value = reflected;
  });
  input.addEventListener("change", () => {
    const next = datePickerWireValue(input.value, mode, bound);
    if (next === null) return;
    const previous = bound;
    bound = next;
    emitChanged(api, node.attrs["bind"], previous, next);
  });
  return wrap;
};

export const combobox: ElementFactory = (node, _ctx, api) => {
  const wrap = el("div", "dsx-combobox");
  const input = el("input", "dsx-combobox-input");
  const list = el("div", "dsx-combobox-listbox");
  const listId = `dsx-combobox-${++controlSequence}`;
  input.type = "text";
  input.autocomplete = "off";
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-controls", listId);
  input.setAttribute("aria-expanded", "false");
  list.id = listId;
  list.setAttribute("role", "listbox");
  list.hidden = true;
  // The search-type clear affordance: present only while the field is filled;
  // clearing routes through the same change contract as typing.
  const clear = el("button", "dsx-combobox-clear");
  clear.type = "button";
  clear.setAttribute("data-dsx-part", "clear");
  clear.setAttribute("aria-label", "Clear search");
  clear.hidden = true;
  clear.appendChild(clearGlyph());
  wrap.append(input, clear, list);
  bindTint(wrap, node, api);
  bindDisabled(node, api, [input]);
  if (node.attrs["placeholder"] !== undefined) {
    api.bindText(node.attrs["placeholder"], (value) => {
      input.placeholder = value;
      if (node.attrs["a11yLabel"] === undefined) input.setAttribute("aria-label", value || "Search options");
    });
  }
  api.bindText(node.attrs["a11yLabel"] ?? node.attrs["placeholder"] ?? "Search options", (value) => {
    input.setAttribute("aria-label", value || "Search options");
  });

  let options: NativeControlOption[] = [];
  let query = "";
  let focused = false;
  let showResults = false;
  let active = -1;
  let matches: NativeControlOption[] = [];

  const close = (): void => {
    active = -1;
    list.hidden = true;
    list.replaceChildren();
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
  };
  const reflectClear = (): void => { clear.hidden = query.length === 0; };
  const clearValue = (): void => {
    if (query.length === 0) return;
    const previous = query;
    query = "";
    input.value = "";
    active = -1;
    showResults = false;
    emitChanged(api, node.attrs["bind"], previous, "");
    reflectClear();
    close();
  };
  const choose = (index: number): void => {
    const option = matches[index];
    if (option === undefined) return;
    const previous = query;
    query = option.value;
    input.value = query;
    reflectClear();
    emitChanged(api, node.attrs["bind"], previous, query);
    // Native on:select has no intrinsic payload; arg:* remains the portable payload
    // mechanism. The useful selection fields are nevertheless exposed to web JSE.
    api.handler("select", { value: option.value, label: option.label } as Dict);
    showResults = false;
    close();
    input.blur();
  };
  const reflectActive = (): void => {
    const rows = Array.from(list.querySelectorAll<HTMLElement>("[role=option]"));
    rows.forEach((row, index) => row.setAttribute("aria-selected", String(index === active)));
    const row = rows[active];
    if (row !== undefined) {
      input.setAttribute("aria-activedescendant", row.id);
      row.scrollIntoView({ block: "nearest" });
    } else {
      input.removeAttribute("aria-activedescendant");
    }
  };
  const render = (): void => {
    const needle = query.slice(0, NATIVE_CONTROL_TEXT_LIMIT).toLocaleLowerCase();
    matches = needle.length === 0 ? [] : options.filter((option) => option.label.toLocaleLowerCase().includes(needle));
    if (!focused || !showResults || matches.length === 0) { close(); return; }
    const rows = matches.map((option, index) => {
      const row = el("button", "dsx-combobox-option");
      row.type = "button";
      row.id = `${listId}-option-${index}`;
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", "false");
      row.tabIndex = -1;
      row.textContent = option.label;
      row.addEventListener("pointerdown", (event) => event.preventDefault());
      row.addEventListener("click", () => choose(index));
      return row;
    });
    list.replaceChildren(...rows);
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
    active = Math.min(Math.max(active, -1), matches.length - 1);
    reflectActive();
  };
  bindOptions(node, api, (next) => { options = next; render(); });
  api.bindValue(node.attrs["bind"], (value) => {
    query = boundedText(value);
    if (input.value !== query) input.value = query;
    if (focused && query.length > 0) showResults = true;
    reflectClear();
    render();
  });
  // The pointerdown guard keeps the input focused through the click, like the
  // option rows; clearing returns focus for keyboard activations too.
  clear.addEventListener("pointerdown", (event) => event.preventDefault());
  clear.addEventListener("click", () => {
    clearValue();
    input.focus();
  });
  input.addEventListener("focus", () => { focused = true; showResults = true; render(); });
  input.addEventListener("blur", () => { focused = false; showResults = false; close(); });
  input.addEventListener("input", () => {
    const next = input.value.slice(0, NATIVE_CONTROL_TEXT_LIMIT);
    if (input.value !== next) input.value = next;
    const previous = query;
    query = next;
    showResults = true;
    emitChanged(api, node.attrs["bind"], previous, query);
    active = -1;
    reflectClear();
    render();
  });
  input.addEventListener("keydown", (event) => {
    // Escape follows the combobox convention: an open list closes first; a second
    // press (or Escape with the list closed) clears the filled field.
    if (event.key === "Escape") {
      const wasOpen = !list.hidden;
      showResults = false;
      close();
      if (!wasOpen) clearValue();
      return;
    }
    if (matches.length === 0 && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      showResults = true;
      render();
    }
    if (matches.length === 0) return;
    if (event.key === "ArrowDown") active = (active + 1) % matches.length;
    else if (event.key === "ArrowUp") active = active <= 0 ? matches.length - 1 : active - 1;
    else if (event.key === "Home") active = 0;
    else if (event.key === "End") active = matches.length - 1;
    else if (event.key === "Enter" && active >= 0) { event.preventDefault(); choose(active); return; }
    else return;
    event.preventDefault();
    reflectActive();
  });
  return wrap;
};

export function normalizeOtpLength(value: unknown): number {
  return Math.min(Math.max(Math.trunc(finite(value, 6)), 1), OTP_LENGTH_LIMIT);
}

export function normalizeOtpValue(value: unknown, length: number): string {
  return Array.from(boundedText(value))
    .filter((character) => /\p{N}/u.test(character))
    .slice(0, normalizeOtpLength(length))
    .join("");
}

export const otp: ElementFactory = (node, _ctx, api) => {
  const wrap = el("label", "dsx-otp");
  const input = el("input", "dsx-otp-input");
  const boxes = el("span", "dsx-otp-boxes");
  const length = normalizeOtpLength(node.attrs["length"]);
  input.type = "text";
  input.inputMode = "numeric";
  input.autocomplete = "one-time-code";
  input.pattern = "[0-9]*";
  api.bindText(node.attrs["a11yLabel"] ?? "One-time code", (value) => input.setAttribute("aria-label", value));
  // As with tint, the default geometry is CSS-owned and therefore normally
  // overridable. An explicit (including reactive) boxSize attribute is stronger.
  if (node.attrs["boxSize"] !== undefined) {
    api.bindText(node.attrs["boxSize"], (value) => {
      const boxSize = clamp(finite(value, 48), 24, 96);
      wrap.style.setProperty("--dsx-otp-box-size", `${boxSize}px`);
    });
  }
  bindTint(wrap, node, api);
  bindDisabled(node, api, [input]);
  wrap.append(input, boxes);

  let value = "";
  let focused = false;
  const cells = Array.from({ length }, () => {
    const cell = el("span", "dsx-otp-box");
    cell.setAttribute("aria-hidden", "true");
    return cell;
  });
  boxes.replaceChildren(...cells);
  const render = (): void => {
    const digits = Array.from(normalizeOtpValue(value, length));
    cells.forEach((cell, index) => {
      cell.textContent = digits[index] ?? "";
      cell.dataset["active"] = String(focused && index === Math.min(digits.length, length - 1) && digits.length < length);
    });
  };
  api.bindValue(node.attrs["bind"], (next) => {
    value = boundedText(next);
    if (input.value !== value) input.value = value;
    render();
  });
  input.addEventListener("focus", () => { focused = true; render(); });
  input.addEventListener("blur", () => { focused = false; render(); });
  input.addEventListener("input", () => {
    const next = normalizeOtpValue(input.value, length);
    input.value = next;
    const previous = value;
    value = next;
    emitChanged(api, node.attrs["bind"], previous, next);
    render();
    if (Array.from(next).length === length) api.handler("complete");
  });
  return wrap;
};

export type RangeBounds = { min: number; max: number; step: number | null; degenerate: boolean };

export function normalizeRangeBounds(minValue: unknown, maxValue: unknown, stepValue: unknown): RangeBounds {
  const authoredMin = finite(minValue, 0);
  const authoredMax = finite(maxValue, 1);
  const min = Math.min(authoredMin, authoredMax);
  const max = Math.max(authoredMin, authoredMax);
  const step = finite(stepValue, Number.NaN);
  return { min, max, step: Number.isFinite(step) && step > 0 ? step : null, degenerate: min === max };
}

function snapRange(value: number, bounds: RangeBounds): number {
  const clamped = clamp(Number.isFinite(value) ? value : bounds.min, bounds.min, bounds.max);
  if (bounds.step === null || bounds.degenerate) return clamped;
  const snapped = bounds.min + Math.round((clamped - bounds.min) / bounds.step) * bounds.step;
  return clamp(Number(snapped.toPrecision(12)), bounds.min, bounds.max);
}

export const rangeslider: ElementFactory = (node, ctx, api) => {
  const wrap = el("div", "dsx-rangeslider");
  wrap.setAttribute("data-dsx-component", "range-slider");
  const track = el("span", "dsx-rangeslider-track");
  track.setAttribute("data-dsx-part", "track");
  const selectedTrack = el("span", "dsx-rangeslider-selected");
  selectedTrack.setAttribute("data-dsx-part", "fill");
  const lowInput = el("input", "dsx-rangeslider-input dsx-rangeslider-low");
  lowInput.setAttribute("data-dsx-part", "lower-thumb");
  const highInput = el("input", "dsx-rangeslider-input dsx-rangeslider-high");
  highInput.setAttribute("data-dsx-part", "upper-thumb");
  const bounds = normalizeRangeBounds(node.attrs["min"], node.attrs["max"], node.attrs["step"]);
  const domMax = bounds.degenerate ? bounds.min + 1 : bounds.max;
  for (const input of [lowInput, highInput]) {
    input.type = "range";
    input.min = String(bounds.min);
    input.max = String(domMax);
    input.step = bounds.step === null ? "any" : String(bounds.step);
  }
  api.bindText(node.attrs["a11yLowLabel"] ?? "Lower value", (value) => lowInput.setAttribute("aria-label", value));
  api.bindText(node.attrs["a11yHighLabel"] ?? "Upper value", (value) => highInput.setAttribute("aria-label", value));
  wrap.setAttribute("role", "group");
  api.bindText(node.attrs["a11yLabel"] ?? "Value range", (value) => wrap.setAttribute("aria-label", value));
  wrap.append(track, selectedTrack, lowInput, highInput);
  bindTint(wrap, node, api);
  bindDisabled(node, api, [lowInput, highInput], bounds.degenerate);

  let low = bounds.min;
  let high = bounds.max;
  let lowBound: unknown = undefined;
  let highBound: unknown = undefined;
  let draggingLow = false;
  let draggingHigh = false;
  const render = (): void => {
    // Programmatic values remain exact (native step snaps only user movement).
    // At rest, recompute from BOTH raw bindings on every pass: when authored values
    // cross, the native/SSR rule is low-first and raises the displayed high to low.
    // Keeping the raw high avoids a stale raised value after low later moves down.
    const lowSource = draggingLow ? low : finite(lowBound, bounds.min);
    const highSource = draggingHigh ? high : finite(highBound, bounds.max);
    low = clamp(lowSource, bounds.min, bounds.max);
    high = Math.max(clamp(highSource, bounds.min, bounds.max), low);
    lowInput.value = String(bounds.degenerate ? bounds.min : low);
    highInput.value = String(bounds.degenerate ? domMax : high);
    lowInput.max = String(bounds.degenerate ? domMax : high);
    highInput.min = String(bounds.degenerate ? bounds.min : low);
    const span = bounds.degenerate ? 1 : bounds.max - bounds.min;
    wrap.style.setProperty("--dsx-range-low", `${((low - bounds.min) / span) * 100}%`);
    wrap.style.setProperty("--dsx-range-high", `${((high - bounds.min) / span) * 100}%`);
    lowInput.setAttribute("aria-valuenow", String(low));
    highInput.setAttribute("aria-valuenow", String(high));
  };
  api.bindValue(node.attrs["bindLow"], (value) => {
    lowBound = value;
    if (!draggingLow) low = clamp(finite(value, bounds.min), bounds.min, bounds.max);
    render();
  });
  api.bindValue(node.attrs["bindHigh"], (value) => {
    highBound = value;
    if (!draggingHigh) high = clamp(finite(value, bounds.max), bounds.min, bounds.max);
    render();
  });

  type Thumb = "low" | "high";
  const timers: Record<Thumb, ReturnType<typeof setTimeout> | null> = { low: null, high: null };
  const lastPush: Record<Thumb, number> = { low: 0, high: 0 };
  const commit = (thumb: Thumb): void => {
    const path = thumb === "low" ? node.attrs["bindLow"] : node.attrs["bindHigh"];
    const previous = thumb === "low" ? lowBound : highBound;
    const value = thumb === "low" ? low : high;
    if (thumb === "low") lowBound = value; else highBound = value;
    emitChanged(api, path, previous, value);
    lastPush[thumb] = Date.now();
  };
  const schedule = (thumb: Thumb): void => {
    const elapsed = Date.now() - lastPush[thumb];
    if (elapsed >= 80) { commit(thumb); return; }
    if (timers[thumb] !== null) return;
    timers[thumb] = setTimeout(() => { timers[thumb] = null; commit(thumb); }, 80 - elapsed);
  };
  const finish = (thumb: Thumb): void => {
    if (timers[thumb] !== null) { clearTimeout(timers[thumb]!); timers[thumb] = null; }
    commit(thumb);
    if (thumb === "low") draggingLow = false; else draggingHigh = false;
  };
  const wireThumb = (thumb: Thumb, input: HTMLInputElement): void => {
    input.addEventListener("pointerdown", () => { if (thumb === "low") draggingLow = true; else draggingHigh = true; });
    input.addEventListener("pointercancel", () => {
      if (timers[thumb] !== null) { clearTimeout(timers[thumb]!); timers[thumb] = null; }
      if (thumb === "low") {
        draggingLow = false;
        low = clamp(finite(lowBound, bounds.min), bounds.min, bounds.max);
      } else {
        draggingHigh = false;
        high = clamp(finite(highBound, bounds.max), bounds.min, bounds.max);
      }
      render();
    });
    input.addEventListener("input", () => {
      // Keyboard input has no pointerdown; mark it in flight before render so the
      // newly entered value is not replaced by the prior bound value.
      if (thumb === "low") draggingLow = true; else draggingHigh = true;
      const value = snapRange(finite(input.value, thumb === "low" ? low : high), bounds);
      if (thumb === "low") low = Math.min(value, high); else high = Math.max(value, low);
      render();
      schedule(thumb);
    });
    input.addEventListener("change", () => finish(thumb));
  };
  wireThumb("low", lowInput);
  wireThumb("high", highInput);
  ctx.disposers.push(() => {
    for (const timer of Object.values(timers)) if (timer !== null) clearTimeout(timer);
  });
  render();
  return wrap;
};

export const NATIVE_CONTROL_ELEMENTS: Readonly<Record<string, ElementFactory>> = {
  picker,
  datepicker,
  date: datepicker,
  combobox,
  otp,
  rangeslider,
  wheelpicker,
};

export const NATIVE_CONTROL_TAGS: ReadonlySet<string> = new Set(Object.keys(NATIVE_CONTROL_ELEMENTS));

export function registerNativeControls(): void {
  Object.assign(ELEMENTS, NATIVE_CONTROL_ELEMENTS);
}

/** Defaults only. The stable class/semantic DOM contract remains useful with this
 * entire layer overridden or omitted. */
export const NATIVE_CONTROLS_CSS = `@layer dsx-elements {
  .dsx-native-choice, .dsx-datepicker, .dsx-combobox, .dsx-otp, .dsx-rangeslider {
    --dsx-control-tint: var(--dsx-accent);
    min-width: 0;
    color: var(--dsx-label);
    font-family: var(--dsx-font);
  }
  ` +
// Native-control wells share the field-well surface: soft recessed fill seated by
// the xs elevation whisper, the size-rhythm radius (--dsx-radius-lg: 14px mobile /
// 12px fine-desktop; compact wells re-pin --dsx-field-well-radius to
// var(--dsx-radius)), one-step hover deepening on the fast duration, and a focus
// border that animates to label ink under the ring.
`  .dsx-picker-select, .dsx-datepicker-input, .dsx-combobox-input {
    box-sizing: border-box;
    min-width: 0;
    min-height: 44px;
    padding: var(--dsx-space-2) var(--dsx-control-padding-inline);
    border: 1px solid var(--dsx-outline-soft);
    border-radius: var(--dsx-field-well-radius, var(--dsx-radius-lg));
    color: var(--dsx-label);
    accent-color: var(--dsx-control-tint);
    background: var(--dsx-surface-recessed);
    box-shadow: var(--dsx-shadow-xs);
    font: inherit;
    transition:
      border-color var(--dsx-dur-base) var(--dsx-ease),
      background-color var(--dsx-dur-fast) var(--dsx-ease),
      box-shadow var(--dsx-dur-base) var(--dsx-ease);
  }
  @media (hover: hover) and (pointer: fine) {
    .dsx-picker-select:not(:disabled):hover,
    .dsx-datepicker-input:not(:disabled):hover,
    .dsx-combobox-input:not(:disabled):not(:read-only):hover {
      border-color: var(--dsx-separator);
      background: color-mix(in srgb, var(--dsx-surface-recessed) 95%, var(--dsx-label));
    }
  }
  .dsx-picker-select:not(:disabled):active {
    background: color-mix(in srgb, var(--dsx-surface-recessed) 91%, var(--dsx-label));
  }
  .dsx-picker-select:focus-visible,
  .dsx-datepicker-input:focus-visible, .dsx-combobox-input:focus-visible {
    outline: none;
    border-color: var(--dsx-label);
    box-shadow: var(--dsx-focus-ring), var(--dsx-shadow-xs);
  }
  .dsx-wheelpicker-select:focus-visible {
    outline: none;
    border-color: var(--dsx-control-tint);
    box-shadow: var(--dsx-focus-ring);
  }
  .dsx-otp-input:focus-visible, .dsx-rangeslider-input:focus-visible {
    outline: none;
    box-shadow: none;
  }
  .dsx-picker-select[aria-invalid="true"], .dsx-datepicker-input[aria-invalid="true"],
  .dsx-combobox-input[aria-invalid="true"] {
    border-color: var(--dsx-destructive);
  }
  .dsx-native-choice { display: inline-flex; max-width: 100%; }
  .dsx-picker { position: relative; align-items: center; min-height: var(--dsx-control-height); }
  .dsx-picker::after {
    content: "";
    position: absolute;
    inset-block-start: calc(50% - 5px);
    inset-inline-end: var(--dsx-control-padding-inline);
    inset-block-end: auto;
    inset-inline-start: auto;
    width: 7px;
    height: 7px;
    border: 0 solid var(--dsx-secondary-label);
    border-width: 0 1.5px 1.5px 0;
    transform: rotate(45deg);
    pointer-events: none;
    transition:
      transform var(--dsx-dur-slow) var(--dsx-ease-spring),
      border-color var(--dsx-dur-fast) var(--dsx-ease);
  }
  .dsx-picker:focus-within::after {
    border-color: var(--dsx-accent);
    transform: rotate(225deg);
  }
  .dsx-picker-select {
    appearance: none;
    width: 100%;
    height: 44px;
    padding-inline-end: 2.25rem;
    cursor: pointer;
  }
  .dsx-picker-select:disabled, .dsx-wheelpicker-select:disabled,
  .dsx-datepicker-input:disabled, .dsx-combobox-input:disabled,
  .dsx-otp-input:disabled, .dsx-rangeslider-input:disabled {
    cursor: not-allowed;
  }
  .dsx-picker-select:disabled, .dsx-wheelpicker-select:disabled,
  .dsx-datepicker-input:disabled, .dsx-combobox-input:disabled {
    opacity: .48;
    filter: saturate(.5);
  }
  .dsx-otp:has(> .dsx-otp-input:disabled),
  .dsx-rangeslider:has(> .dsx-rangeslider-input:disabled) {
    opacity: .48;
    filter: saturate(.5);
  }
  .dsx-combobox-input:read-only {
    color: var(--dsx-secondary-label);
    background: color-mix(in srgb, var(--dsx-surface-recessed) 72%, transparent);
  }

  .dsx-wheelpicker { display: block; width: 100%; }
  .dsx-wheelpicker-select {
    box-sizing: border-box;
    width: 100%;
    height: 168px;
    padding: var(--dsx-space-1);
    overflow-y: auto;
    border: 1px solid var(--dsx-outline-soft);
    border-radius: var(--dsx-radius-card);
    color: var(--dsx-label);
    accent-color: var(--dsx-control-tint);
    background: var(--dsx-surface-recessed);
    font: inherit;
    line-height: 30px;
    transition:
      border-color var(--dsx-dur-base) var(--dsx-ease),
      box-shadow var(--dsx-dur-base) var(--dsx-ease);
  }
  .dsx-wheelpicker-select > option {
    min-height: 30px;
    padding: 5px var(--dsx-space-2);
    border-radius: var(--dsx-radius-sm);
  }
  .dsx-wheelpicker-select > option:checked {
    color: var(--dsx-label);
    background: color-mix(in srgb, var(--dsx-control-tint) 14%, transparent);
  }

  .dsx-datepicker { display: flex; align-items: center; gap: var(--dsx-space-3); width: 100%; }
  .dsx-datepicker-label { flex: 1 1 auto; min-width: 0; }
  .dsx-datepicker-input { flex: 0 1 auto; }
  .dsx-datepicker-input::-webkit-calendar-picker-indicator {
    cursor: pointer;
    opacity: .72;
    transition: opacity var(--dsx-dur-fast) var(--dsx-ease);
  }
  .dsx-datepicker-input:hover::-webkit-calendar-picker-indicator,
  .dsx-datepicker-input:focus-visible::-webkit-calendar-picker-indicator { opacity: 1; }

  .dsx-combobox { position: relative; display: flex; flex-direction: column; gap: var(--dsx-space-2); width: 100%; }
  .dsx-combobox-input { width: 100%; padding-inline-end: 2.25rem; caret-color: var(--dsx-control-tint); }
  .dsx-combobox-input::placeholder { color: var(--dsx-secondary-label); opacity: 1; }
  ` +
// The clear affordance: absolute at the trailing edge, shown only while filled.
// The 0.5rem padding expands the 17px glyph to a 33px hit box; the anchor offset
// compensates so the glyph itself stays put (the flow-layout padding/negative-
// margin idiom, expressed against the absolute anchor).
`  .dsx-combobox-clear {
    position: absolute;
    z-index: 1;
    top: 50%;
    inset-inline-end: 0.25rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    margin: 0;
    padding: 0.5rem;
    border: 0;
    border-radius: var(--dsx-radius-full);
    color: var(--dsx-secondary-label);
    background: none;
    line-height: 0;
    cursor: pointer;
    transform: translateY(-50%);
    transition:
      color var(--dsx-dur-fast) var(--dsx-ease),
      background-color var(--dsx-dur-fast) var(--dsx-ease);
  }
  .dsx-combobox-clear[hidden] { display: none; }
  .dsx-combobox-input:disabled ~ .dsx-combobox-clear { display: none; }
  .dsx-combobox-clear:focus-visible {
    outline: var(--dsx-focus-ring-width) solid var(--dsx-accent);
    outline-offset: var(--dsx-focus-ring-offset);
    z-index: 1;
  }
  @media (hover: hover) and (pointer: fine) {
    .dsx-combobox-clear:hover { color: var(--dsx-label); background: var(--dsx-fill); }
  }
  .dsx-combobox-listbox {
    position: absolute;
    z-index: 30;
    inset: calc(100% + var(--dsx-space-1)) 0 auto 0;
    max-height: 246px;
    overflow-y: auto;
    padding: var(--dsx-space-1);
    border: 1px solid var(--dsx-outline-soft);
    border-radius: var(--dsx-radius-card);
    background: var(--dsx-surface-raised);
    box-shadow: var(--dsx-shadow-3);
  }
  .dsx-combobox-listbox[hidden] { display: none; }
  .dsx-combobox-option {
    display: block;
    width: 100%;
    min-height: var(--dsx-control-height);
    padding: var(--dsx-space-2) var(--dsx-space-3);
    border: 0;
    border-radius: var(--dsx-radius-control);
    color: var(--dsx-label);
    background: transparent;
    font: inherit;
    text-align: start;
    cursor: pointer;
    transition:
      background-color var(--dsx-dur-fast) var(--dsx-ease),
      color var(--dsx-dur-fast) var(--dsx-ease);
  }
  @media (hover: hover) and (pointer: fine) {
    .dsx-combobox-option:hover { background: var(--dsx-fill); }
  }
  .dsx-combobox-option[aria-selected="true"] {
    color: var(--dsx-on-accent);
    background: var(--dsx-control-tint);
  }
  .dsx-combobox-option:active {
    color: var(--dsx-on-accent);
    background: color-mix(in srgb, var(--dsx-control-tint) 88%, var(--dsx-label));
  }

  .dsx-otp {
    --dsx-otp-box-size: 48px;
    --dsx-otp-cap-ratio: 0.42;
    position: relative;
    display: inline-flex;
    max-width: 100%;
    overflow-x: auto;
  }
  .dsx-otp-input {
    position: absolute;
    z-index: 1;
    inset: 0;
    width: 100%;
    height: 100%;
    margin: 0;
    border: 0;
    opacity: .02;
    color: transparent;
    background: transparent;
    caret-color: transparent;
  }
  .dsx-otp-boxes {
    display: inline-flex;
    gap: var(--dsx-space-2);
    border-radius: var(--dsx-radius-control);
    pointer-events: none;
  }
  .dsx-otp:has(> .dsx-otp-input:focus-visible) .dsx-otp-boxes { box-shadow: var(--dsx-focus-ring); }
  .dsx-otp-box {
    box-sizing: border-box;
    display: inline-grid;
    place-items: center;
    width: var(--dsx-otp-box-size);
    height: var(--dsx-otp-box-size);
    flex: 0 0 var(--dsx-otp-box-size);
    border: 1px solid var(--dsx-outline-soft);
    border-radius: var(--dsx-radius-control);
    color: var(--dsx-label);
    background: var(--dsx-surface-recessed);
    font-size: calc(var(--dsx-otp-box-size) * var(--dsx-otp-cap-ratio));
    font-weight: var(--dsx-type-headline-weight);
    font-variant-numeric: tabular-nums;
    transition:
      border-color var(--dsx-dur-base) var(--dsx-ease),
      box-shadow var(--dsx-dur-base) var(--dsx-ease),
      background-color var(--dsx-dur-fast) var(--dsx-ease),
      transform var(--dsx-dur-base) var(--dsx-ease-spring);
  }
  .dsx-otp-box[data-active="true"] {
    transform: scale(1.04);
    border-color: var(--dsx-control-tint);
    box-shadow: var(--dsx-focus-ring-inset);
  }

  /* metrics ride the DENSITY PLANE's slider tokens (theme.ts): the desktop default
     and a density= pin resolve the same plane. min-width is the UA range intrinsic
     (~129px = 8rem) so a non-stretch container cannot collapse the pair to 0 (W9). */
  .dsx-rangeslider {
    --dsx-range-track-size: var(--dsx-slider-track-size);
    --dsx-range-thumb-size: var(--dsx-slider-thumb-size);
    --dsx-range-track-color: color-mix(in srgb, var(--dsx-secondary-label) 24%, var(--dsx-surface-recessed));
    --dsx-range-fill-color: var(--dsx-control-tint);
    --dsx-range-thumb-color: var(--dsx-control-knob);
    position: relative;
    display: block;
    width: 100%;
    min-width: 8rem;
    height: var(--dsx-slider-box-height);
    touch-action: none;
  }
  .dsx-rangeslider-track, .dsx-rangeslider-selected {
    position: absolute;
    inset: 50% calc(var(--dsx-range-thumb-size) / 2) auto;
    height: var(--dsx-range-track-size);
    border-radius: var(--dsx-radius-full);
    transform: translateY(-50%);
    pointer-events: none;
  }
  .dsx-rangeslider-track { background: var(--dsx-range-track-color); }
  .dsx-rangeslider-selected {
    left: max(calc(var(--dsx-range-thumb-size) / 2), var(--dsx-range-low));
    right: max(calc(var(--dsx-range-thumb-size) / 2), calc(100% - var(--dsx-range-high)));
    background: var(--dsx-range-fill-color);
  }
  [dir="rtl"] .dsx-rangeslider-selected {
    left: max(calc(var(--dsx-range-thumb-size) / 2), calc(100% - var(--dsx-range-high)));
    right: max(calc(var(--dsx-range-thumb-size) / 2), var(--dsx-range-low));
  }
  .dsx-rangeslider-input {
    appearance: none;
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    margin: 0;
    border: 0;
    pointer-events: none;
    background: transparent;
  }
  .dsx-rangeslider-input::-webkit-slider-runnable-track { height: var(--dsx-range-track-size); background: transparent; }
  .dsx-rangeslider-input::-moz-range-track { height: var(--dsx-range-track-size); background: transparent; }
  /* 1.15x while grabbed (fast in), spring back on release. */
  .dsx-rangeslider-input::-webkit-slider-thumb {
    appearance: none;
    box-sizing: border-box;
    width: var(--dsx-range-thumb-size);
    height: var(--dsx-range-thumb-size);
    margin-top: calc((var(--dsx-range-track-size) - var(--dsx-range-thumb-size)) / 2);
    border: 0;
    border-radius: var(--dsx-radius-full);
    pointer-events: auto;
    background: var(--dsx-range-thumb-color);
    box-shadow: var(--dsx-shadow-2);
    transition:
      transform var(--dsx-dur-base) var(--dsx-ease-spring),
      box-shadow var(--dsx-dur-fast) var(--dsx-ease);
  }
  .dsx-rangeslider-input::-moz-range-thumb {
    box-sizing: border-box;
    width: var(--dsx-range-thumb-size);
    height: var(--dsx-range-thumb-size);
    border: 0;
    border-radius: var(--dsx-radius-full);
    pointer-events: auto;
    background: var(--dsx-range-thumb-color);
    box-shadow: var(--dsx-shadow-2);
    transition:
      transform var(--dsx-dur-base) var(--dsx-ease-spring),
      box-shadow var(--dsx-dur-fast) var(--dsx-ease);
  }
  /* pseudo-element thumbs keep the box-shadow ring at the shared width (the one
     documented exception to the outline recipe) */
  .dsx-rangeslider-input:focus-visible::-webkit-slider-thumb { box-shadow: var(--dsx-focus-ring), var(--dsx-shadow-2); }
  .dsx-rangeslider-input:focus-visible::-moz-range-thumb { box-shadow: var(--dsx-focus-ring), var(--dsx-shadow-2); }
  @media (hover: hover) and (pointer: fine) {
    .dsx-rangeslider-input:not(:disabled):hover::-webkit-slider-thumb { transform: scale(1.05); }
    .dsx-rangeslider-input:not(:disabled):hover::-moz-range-thumb { transform: scale(1.05); }
  }
  .dsx-rangeslider-input:not(:disabled):active::-webkit-slider-thumb {
    transform: scale(1.15);
    box-shadow: var(--dsx-shadow-3);
    transition-duration: var(--dsx-dur-fast);
    transition-timing-function: var(--dsx-ease);
  }
  .dsx-rangeslider-input:not(:disabled):active::-moz-range-thumb {
    transform: scale(1.15);
    box-shadow: var(--dsx-shadow-3);
    transition-duration: var(--dsx-dur-fast);
    transition-timing-function: var(--dsx-ease);
  }
  .dsx-rangeslider-low { z-index: 2; }
  .dsx-rangeslider-high { z-index: 3; }
  .dsx-rangeslider-low:focus, .dsx-rangeslider-low:hover { z-index: 4; }
  @media (pointer: coarse) {
    .dsx-combobox-option { min-height: 44px; }
    .dsx-wheelpicker-select { height: 230px; line-height: 34px; }
    .dsx-wheelpicker-select > option { min-height: 44px; padding-block: var(--dsx-space-1); }
  }

  @media (max-width: 479px) {
    .dsx-datepicker { align-items: stretch; flex-direction: column; gap: var(--dsx-space-2); }
    .dsx-datepicker-input { width: 100%; }
  }
  @media (min-width: 64rem) and (hover: hover) and (pointer: fine) {
    .dsx-picker-select, .dsx-datepicker-input, .dsx-combobox-input {
      min-height: 38px;
      padding: var(--dsx-space-1) var(--dsx-control-padding-inline);
      font-size: var(--dsx-type-body-size);
      line-height: var(--dsx-type-title2-leading);
    }
    .dsx-picker-select { height: 38px; }
  }
  @media (prefers-reduced-motion: reduce) {
    .dsx-picker-select, .dsx-datepicker-input, .dsx-combobox-input,
    .dsx-wheelpicker-select, .dsx-combobox-option, .dsx-combobox-clear,
    .dsx-otp-box, .dsx-picker::after,
    .dsx-datepicker-input::-webkit-calendar-picker-indicator { transition: none; }
    .dsx-rangeslider-input::-webkit-slider-thumb { transition: none; }
    .dsx-rangeslider-input::-moz-range-thumb { transition: none; }
    .dsx-wheelpicker-select { scroll-behavior: auto; }
  }
  @media (forced-colors: active) {
    .dsx-picker-select, .dsx-wheelpicker-select, .dsx-datepicker-input,
    .dsx-combobox-input, .dsx-combobox-listbox, .dsx-otp-box {
      border: 1px solid CanvasText;
      background: Canvas;
      color: CanvasText;
    }
    .dsx-otp-input {
      forced-color-adjust: none;
      opacity: 1;
      color: transparent;
      background: transparent;
    }
    .dsx-picker-select:focus-visible, .dsx-wheelpicker-select:focus-visible,
    .dsx-datepicker-input:focus-visible, .dsx-combobox-input:focus-visible,
    .dsx-otp-input:focus-visible, .dsx-rangeslider-input:focus-visible {
      outline: 2px solid Highlight;
      outline-offset: 2px;
      box-shadow: none;
    }
    .dsx-combobox-option[aria-selected="true"] {
      forced-color-adjust: none;
      color: HighlightText;
      background: Highlight;
    }
    .dsx-otp-box[data-active="true"] { border: 2px solid Highlight; }
    .dsx-rangeslider-track { background: CanvasText; }
    .dsx-rangeslider-selected {
      forced-color-adjust: none;
      background: Highlight;
    }
    .dsx-rangeslider-input::-webkit-slider-thumb { border: 1px solid Highlight; background: Canvas; }
    .dsx-rangeslider-input::-moz-range-thumb { border: 1px solid Highlight; background: Canvas; }
  }
}`;
