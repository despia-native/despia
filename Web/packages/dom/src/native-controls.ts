//
//  native-controls.ts - semantic browser twins for DSX's native input controls.
//  These factories intentionally use real HTML inputs/selects as their interaction
//  surface. The stylesheet only supplies a weak @layer dsx-elements default, so an
//  authored .dsx class/style/theme can replace the look without replacing behavior.
//

import { number, string, truthy } from "@despia/kernel";
import type { Dict } from "@despia/kernel";
import type { XmlNode } from "@despia/compiler/xml";
import { ELEMENTS, type ElementApi, type ElementFactory } from "./elements.ts";

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
  };
  return (tokens[value] ?? value) || "var(--dsx-accent)";
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
  wrap.append(input, list);
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
  const choose = (index: number): void => {
    const option = matches[index];
    if (option === undefined) return;
    const previous = query;
    query = option.value;
    input.value = query;
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
    render();
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
    render();
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { showResults = false; close(); return; }
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
      wrap.style.setProperty("--dsx-otp-font-size", `${boxSize * 0.42}px`);
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
  .dsx-picker-select, .dsx-datepicker-input, .dsx-combobox-input {
    box-sizing: border-box;
    min-width: 0;
    min-height: 44px;
    padding: .625rem .875rem;
    border: 1px solid var(--dsx-outline-soft);
    border-radius: var(--dsx-radius);
    color: var(--dsx-label);
    accent-color: var(--dsx-control-tint);
    background: var(--dsx-surface-recessed);
    box-shadow: inset 0 1px 1px color-mix(in srgb, var(--dsx-label) 4%, transparent),
                0 1px 2px color-mix(in srgb, var(--dsx-label) 5%, transparent);
    font: inherit;
    transition:
      border-color var(--dsx-motion-fast) ease,
      box-shadow var(--dsx-motion-standard) var(--dsx-ease-out),
      background-color var(--dsx-motion-fast) ease;
  }
  .dsx-picker-select:focus-visible, .dsx-wheelpicker-select:focus-visible,
  .dsx-datepicker-input:focus-visible, .dsx-combobox-input:focus-visible,
  .dsx-otp-input:focus-visible, .dsx-rangeslider-input:focus-visible {
    outline: none;
    box-shadow: var(--dsx-focus-ring);
  }
  .dsx-picker-select:focus-visible, .dsx-datepicker-input:focus-visible,
  .dsx-combobox-input:focus-visible {
    border-color: var(--dsx-control-tint);
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
    inset: calc(50% - 5px) .9rem auto auto;
    width: 7px;
    height: 7px;
    border: 0 solid var(--dsx-control-tint);
    border-width: 0 1.5px 1.5px 0;
    transform: rotate(45deg);
    pointer-events: none;
  }
  .dsx-picker-select {
    appearance: none;
    width: 100%;
    height: 44px;
    padding-inline-end: 2.25rem;
    color: var(--dsx-control-tint);
    cursor: pointer;
  }
  .dsx-picker-select:disabled, .dsx-wheelpicker-select:disabled,
  .dsx-datepicker-input:disabled, .dsx-combobox-input:disabled,
  .dsx-otp-input:disabled, .dsx-rangeslider-input:disabled {
    cursor: not-allowed;
    opacity: .48;
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
    padding: 4px;
    overflow-y: auto;
    border: 1px solid var(--dsx-outline-soft);
    border-radius: var(--dsx-radius);
    color: var(--dsx-label);
    accent-color: var(--dsx-control-tint);
    background: var(--dsx-surface-recessed);
    font: inherit;
    line-height: 30px;
  }
  .dsx-wheelpicker-select > option { min-height: 30px; padding: 5px 8px; }

  .dsx-datepicker { display: flex; align-items: center; gap: .75rem; width: 100%; }
  .dsx-datepicker-label { flex: 1 1 auto; min-width: 0; }
  .dsx-datepicker-input { flex: 0 1 auto; color: var(--dsx-control-tint); }

  .dsx-combobox { position: relative; display: flex; flex-direction: column; gap: 6px; width: 100%; }
  .dsx-combobox-input { width: 100%; color: var(--dsx-label); caret-color: var(--dsx-control-tint); }
  .dsx-combobox-input::placeholder { color: var(--dsx-secondary-label); opacity: 1; }
  .dsx-combobox-listbox {
    position: absolute;
    z-index: 30;
    inset: calc(100% + 6px) 0 auto 0;
    max-height: 246px;
    overflow-y: auto;
    padding: 4px;
    border: 1px solid var(--dsx-outline-soft);
    border-radius: 12px;
    background: color-mix(in srgb, var(--dsx-surface-raised) 96%, transparent);
    box-shadow: 0 10px 30px color-mix(in srgb, var(--dsx-label) 18%, transparent);
    backdrop-filter: blur(20px) saturate(140%);
  }
  .dsx-combobox-listbox[hidden] { display: none; }
  .dsx-combobox-option {
    display: block;
    width: 100%;
    min-height: 41px;
    padding: 10px 12px;
    border: 0;
    border-radius: calc(var(--dsx-radius) - 4px);
    color: var(--dsx-label);
    background: transparent;
    font: inherit;
    text-align: start;
    cursor: pointer;
  }
  .dsx-combobox-option:hover, .dsx-combobox-option[aria-selected="true"] {
    color: var(--dsx-label);
    background: var(--dsx-fill);
  }

  .dsx-otp {
    --dsx-otp-box-size: 48px;
    --dsx-otp-font-size: 20.16px;
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
  .dsx-otp-boxes { display: inline-flex; gap: 8px; pointer-events: none; }
  .dsx-otp-box {
    box-sizing: border-box;
    display: inline-grid;
    place-items: center;
    width: var(--dsx-otp-box-size);
    height: var(--dsx-otp-box-size);
    flex: 0 0 var(--dsx-otp-box-size);
    border: 1px solid var(--dsx-outline-soft);
    border-radius: 10px;
    color: var(--dsx-label);
    font-size: var(--dsx-otp-font-size);
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
  .dsx-otp-box[data-active="true"] { border: 2px solid var(--dsx-control-tint); }

  .dsx-rangeslider {
    --dsx-range-track-size: 4px;
    --dsx-range-thumb-size: 22px;
    --dsx-range-track-color: color-mix(in srgb, var(--dsx-secondary-label) 24%, var(--dsx-surface-recessed));
    --dsx-range-fill-color: var(--dsx-control-tint);
    --dsx-range-thumb-color: var(--dsx-control-knob);
    --dsx-range-thumb-shadow-color: var(--dsx-control-knob-shadow);
    position: relative;
    display: block;
    width: 100%;
    height: 44px;
    touch-action: none;
  }
  .dsx-rangeslider-track, .dsx-rangeslider-selected {
    position: absolute;
    inset: 50% calc(var(--dsx-range-thumb-size) / 2) auto;
    height: var(--dsx-range-track-size);
    border-radius: 999px;
    transform: translateY(-50%);
    pointer-events: none;
  }
  .dsx-rangeslider-track {
    background: var(--dsx-range-track-color);
    box-shadow:
      inset 0 1px 1px color-mix(in srgb, var(--dsx-label) 11%, transparent),
      0 1px 0 color-mix(in srgb, var(--dsx-control-knob) 38%, transparent);
  }
  .dsx-rangeslider-selected {
    left: max(calc(var(--dsx-range-thumb-size) / 2), var(--dsx-range-low));
    right: max(calc(var(--dsx-range-thumb-size) / 2), calc(100% - var(--dsx-range-high)));
    background: var(--dsx-range-fill-color);
    box-shadow: inset 0 1px 0 color-mix(in srgb, var(--dsx-control-knob) 26%, transparent);
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
    height: 44px;
    margin: 0;
    border: 0;
    pointer-events: none;
    background: transparent;
  }
  .dsx-rangeslider-input::-webkit-slider-runnable-track { height: var(--dsx-range-track-size); background: transparent; }
  .dsx-rangeslider-input::-moz-range-track { height: var(--dsx-range-track-size); background: transparent; }
  .dsx-rangeslider-input::-webkit-slider-thumb {
    appearance: none;
    box-sizing: border-box;
    width: var(--dsx-range-thumb-size);
    height: var(--dsx-range-thumb-size);
    margin-top: calc((var(--dsx-range-track-size) - var(--dsx-range-thumb-size)) / 2);
    border: var(--dsx-hairline) solid color-mix(in srgb, var(--dsx-control-tint) 48%, var(--dsx-outline-soft));
    border-radius: 50%;
    pointer-events: auto;
    background: linear-gradient(
      165deg,
      var(--dsx-range-thumb-color),
      var(--dsx-range-thumb-shadow-color)
    );
    box-shadow:
      inset 0 1px 0 var(--dsx-inner-highlight),
      0 .5px 3px color-mix(in srgb, var(--dsx-label) 18%, transparent),
      0 4px 10px color-mix(in srgb, var(--dsx-label) 13%, transparent);
    transition:
      box-shadow var(--dsx-motion-standard) var(--dsx-ease-out),
      transform var(--dsx-motion-fast) var(--dsx-ease-out);
  }
  .dsx-rangeslider-input::-moz-range-thumb {
    box-sizing: border-box;
    width: var(--dsx-range-thumb-size);
    height: var(--dsx-range-thumb-size);
    border: var(--dsx-hairline) solid color-mix(in srgb, var(--dsx-control-tint) 48%, var(--dsx-outline-soft));
    border-radius: 50%;
    pointer-events: auto;
    background: linear-gradient(
      165deg,
      var(--dsx-range-thumb-color),
      var(--dsx-range-thumb-shadow-color)
    );
    box-shadow:
      inset 0 1px 0 var(--dsx-inner-highlight),
      0 .5px 3px color-mix(in srgb, var(--dsx-label) 18%, transparent),
      0 4px 10px color-mix(in srgb, var(--dsx-label) 13%, transparent);
    transition:
      box-shadow var(--dsx-motion-standard) var(--dsx-ease-out),
      transform var(--dsx-motion-fast) var(--dsx-ease-out);
  }
  .dsx-rangeslider-input:focus-visible::-webkit-slider-thumb,
  .dsx-rangeslider-input:focus-visible::-moz-range-thumb {
    box-shadow:
      inset 0 1px 0 var(--dsx-inner-highlight),
      0 .5px 3px color-mix(in srgb, var(--dsx-label) 18%, transparent),
      0 0 0 3px var(--dsx-control-tint);
  }
  .dsx-rangeslider-input:not(:disabled):active::-webkit-slider-thumb,
  .dsx-rangeslider-input:not(:disabled):active::-moz-range-thumb { transform: scale(1.08); }
  .dsx-rangeslider-low { z-index: 2; }
  .dsx-rangeslider-high { z-index: 3; }
  .dsx-rangeslider-low:focus, .dsx-rangeslider-low:hover { z-index: 4; }
  @media (min-width: 64rem) and (hover: hover) and (pointer: fine) {
    .dsx-rangeslider {
      --dsx-range-track-size: 3px;
      --dsx-range-thumb-size: 18px;
      height: 32px;
    }
    .dsx-rangeslider-input { height: 32px; }
  }
  @media (pointer: coarse) {
    .dsx-rangeslider {
      --dsx-range-track-size: 4px;
      --dsx-range-thumb-size: 22px;
      height: 44px;
    }
    .dsx-rangeslider-input { height: 44px; }
  }

  @media (max-width: 479px) {
    .dsx-datepicker { align-items: stretch; flex-direction: column; gap: .375rem; }
    .dsx-datepicker-input { width: 100%; }
  }
  @media (min-width: 64rem) and (hover: hover) and (pointer: fine) {
    .dsx-picker-select, .dsx-datepicker-input, .dsx-combobox-input {
      min-height: 38px;
      padding: .4375rem .75rem;
      font-size: .9375rem;
      line-height: 1.2;
    }
    .dsx-picker-select { height: 38px; }
    .dsx-picker-select:not(:disabled):not(:focus-visible):hover,
    .dsx-datepicker-input:not(:disabled):not(:focus-visible):hover,
    .dsx-combobox-input:not(:disabled):not(:focus-visible):hover {
      border-color: color-mix(in srgb, var(--dsx-label) 24%, var(--dsx-separator));
      background: color-mix(in srgb, var(--dsx-surface-recessed) 94%, var(--dsx-label));
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .dsx-picker-select, .dsx-datepicker-input, .dsx-combobox-input { transition: none; }
    .dsx-rangeslider-input::-webkit-slider-thumb,
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
    .dsx-rangeslider-input::-webkit-slider-thumb { border-color: Highlight; background: Canvas; }
    .dsx-rangeslider-input::-moz-range-thumb { border-color: Highlight; background: Canvas; }
  }
}`;
