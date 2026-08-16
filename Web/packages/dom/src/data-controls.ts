//
//  data-controls.ts - semantic, browser-native twins for DSX's structured data
//  and selection controls. Factories own behavior and accessibility; appearance
//  stays in the weak dsx-elements layer so component and application CSS wins.
//

import { isDict, string, truthy, rubberBand, type Dict } from "@despia/kernel";
import type { XmlNode } from "@despia/compiler/xml";
import type { MountCtx } from "./mount.ts";
import {
  ELEMENTS, GLOBAL_ELEMENTS, iconSvg, type ElementApi, type ElementFactory,
} from "./elements.ts";

export const DATA_CONTROL_LIMITS = Object.freeze({
  tableRows: 1_000,
  tableColumns: 64,
  options: 256,
  marks: 2_000,
  textCharacters: 2_048,
  refreshPullPixels: 72,
  refreshPullMaximum: 128,
  refreshGraceMs: 350,
  refreshBusyStartMs: 50,
  refreshBusyMaximumMs: 120_000,
});

export type DataControlOption = Readonly<{ value: string; label: string }>;
export type CalendarDate = Readonly<{ year: number; month: number; day: number }>;
export type CalendarGrid = Readonly<{ days: number; leading: number }>;

let dataControlSequence = 0;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.className = cls;
  return element;
}

function boundedText(value: unknown): string {
  return string(value).substring(0, DATA_CONTROL_LIMITS.textCharacters);
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
  if (node.attrs["color"] === undefined) return;
  api.bindText(node.attrs["color"], (value) => root.style.setProperty("--dsx-data-tint", colorValue(value)));
}

function bindDisabled(
  root: HTMLElement,
  node: XmlNode,
  api: ElementApi,
  controls: () => readonly (HTMLButtonElement | HTMLInputElement)[],
): () => void {
  let declared = false;
  let conditional = false;
  const apply = (): void => {
    const disabled = declared || conditional;
    root.setAttribute("data-dsx-disabled", String(disabled));
    for (const control of controls()) {
      control.disabled = disabled || control.dataset["dsxIntrinsicDisabled"] === "true";
    }
  };
  if (node.attrs["disabled"] !== undefined) {
    api.bindText(node.attrs["disabled"], (value) => { declared = truthy(value); apply(); });
  }
  if (node.attrs["disabled-if"] !== undefined) {
    api.bindValue(node.attrs["disabled-if"], (value) => { conditional = truthy(value); apply(); });
  }
  apply();
  return apply;
}

export function parseDataControlCsv(source: string, limit: number = DATA_CONTROL_LIMITS.options): string[] {
  const out: string[] = [];
  for (const part of source.split(",")) {
    if (out.length >= limit) break;
    if (part.length === 0) continue;
    const value = boundedText(part.trim());
    if (value.length > 0) out.push(value);
  }
  return out;
}

export function normalizeDataControlOptions(
  source: unknown,
  valueField = "id",
  labelField = "label",
): DataControlOption[] {
  if (!Array.isArray(source)) return [];
  const out: DataControlOption[] = [];
  for (const raw of source) {
    if (out.length >= DATA_CONTROL_LIMITS.options) break;
    if (isDict(raw)) {
      const value = boundedText((raw as Dict)[valueField] ?? (raw as Dict)[labelField]);
      if (value.length === 0) continue;
      out.push({ value, label: boundedText((raw as Dict)[labelField] ?? value) || value });
    } else {
      const value = boundedText(raw);
      if (value.length > 0) out.push({ value, label: value });
    }
  }
  return out;
}

function bindOptions(node: XmlNode, api: ElementApi, apply: (options: DataControlOption[]) => void): void {
  if (node.attrs["optionsKey"] !== undefined) {
    api.bindValue(node.attrs["optionsKey"], (value) => apply(normalizeDataControlOptions(
      value,
      node.attrs["valueField"] ?? "id",
      node.attrs["labelField"] ?? "label",
    )));
  } else {
    api.bindText(node.attrs["options"] ?? "", (value) => apply(
      parseDataControlCsv(value).map((option) => ({ value: option, label: option })),
    ));
  }
}

function sameValue(a: unknown, b: unknown): boolean {
  return Object.is(a, b) || string(a) === string(b);
}

function emitChange(api: ElementApi, path: string | undefined, previous: unknown, value: unknown): void {
  if (sameValue(previous, value)) return;
  api.writeBack(path, value);
  api.handler("change", { value });
}

// MARK: - Table

function normalizeTableRows(value: unknown): readonly Dict[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, DATA_CONTROL_LIMITS.tableRows).map((row) => isDict(row) ? row as Dict : { value: row });
}

export const Table: ElementFactory = (node, _ctx, api) => {
  const frame = el("div", "dsx-table-frame");
  const table = el("table", "dsx-table");
  const head = document.createElement("thead");
  const body = document.createElement("tbody");
  frame.tabIndex = 0;
  frame.setAttribute("role", "region");
  frame.setAttribute("aria-label", node.attrs["a11yLabel"] ?? node.attrs["label"] ?? "Data table");
  table.append(head, body);
  frame.appendChild(table);
  if (node.attrs["color"] !== undefined) {
    api.bindText(node.attrs["color"], (value) => frame.style.setProperty("--dsx-table-color", colorValue(value)));
  }

  let columns: string[] = [];
  let fields: string[] = [];
  let rows: readonly Dict[] = [];
  let sourceRows = 0;
  let warned = false;
  const render = (): void => {
    const resolvedFields = fields.length > 0 ? fields : columns.map((column) => column.toLowerCase());
    const headerRow = document.createElement("tr");
    for (const column of columns) {
      const cell = document.createElement("th");
      cell.scope = "col";
      cell.textContent = column;
      headerRow.appendChild(cell);
    }
    head.replaceChildren(headerRow);
    head.hidden = columns.length === 0;

    const rendered: HTMLTableRowElement[] = [];
    for (const row of rows) {
      const tr = document.createElement("tr");
      const spoken: string[] = [];
      for (const field of resolvedFields.slice(0, DATA_CONTROL_LIMITS.tableColumns)) {
        const value = boundedText(row[field]);
        const td = document.createElement("td");
        td.textContent = value;
        td.title = value;
        spoken.push(value);
        tr.appendChild(td);
      }
      tr.setAttribute("aria-label", spoken.join(", "));
      rendered.push(tr);
    }
    body.replaceChildren(...rendered);
    table.setAttribute("aria-rowcount", String(rows.length + (columns.length > 0 ? 1 : 0)));
    table.setAttribute("aria-colcount", String(Math.max(columns.length, resolvedFields.length)));
    frame.setAttribute("data-dsx-truncated", String(sourceRows > rows.length));
    if (!warned && sourceRows > rows.length) {
      warned = true;
      console.warn(`[dsx dom] <Table> renders the first ${DATA_CONTROL_LIMITS.tableRows} rows`);
    }
  };
  api.bindText(node.attrs["columns"] ?? "", (value) => {
    columns = parseDataControlCsv(value, DATA_CONTROL_LIMITS.tableColumns);
    render();
  });
  api.bindText(node.attrs["fields"] ?? "", (value) => {
    fields = parseDataControlCsv(value, DATA_CONTROL_LIMITS.tableColumns);
    render();
  });
  api.bindValue(node.attrs["bind"], (value) => {
    sourceRows = Array.isArray(value) ? value.length : 0;
    rows = normalizeTableRows(value);
    render();
  });
  return frame;
};

// MARK: - Calendar

/** Date's multi-argument constructor remaps years 0...99 into 1900...1999.
 * setFullYear preserves the proleptic Gregorian wire year used by yyyy-MM-dd. */
function prolepticLocalDate(year: number, monthIndex: number, day: number): Date {
  const date = new Date(0);
  date.setHours(12, 0, 0, 0);
  date.setFullYear(year, monthIndex, day);
  return date;
}

function daysInMonth(year: number, month: number): number {
  return prolepticLocalDate(year, month, 0).getDate();
}

export function parseCalendarDate(value: unknown): CalendarDate | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(string(value).trim());
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || year > 9_999 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  return { year, month, day };
}

export function calendarDateKey(date: CalendarDate): string {
  return `${String(date.year).padStart(4, "0")}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`;
}

export function calendarMonthGrid(year: number, month: number, firstWeekday: number): CalendarGrid {
  const first = prolepticLocalDate(year, month - 1, 1).getDay();
  const normalizedFirst = Math.min(Math.max(Math.trunc(firstWeekday), 0), 6);
  return { days: daysInMonth(year, month), leading: (first - normalizedFirst + 7) % 7 };
}

export function normalizeCalendarLocale(locale: string): string {
  try { return new Intl.Locale(locale || "en").toString(); } catch { return "en"; }
}

export function calendarFirstWeekday(locale: string): number {
  try {
    type WeekInfo = { firstDay: number };
    const resolved = new Intl.Locale(normalizeCalendarLocale(locale)) as Intl.Locale & {
      weekInfo?: WeekInfo;
      getWeekInfo?: () => WeekInfo;
    };
    const day = resolved.getWeekInfo?.().firstDay ?? resolved.weekInfo?.firstDay;
    if (day !== undefined && day >= 1 && day <= 7) return day % 7;
    const region = resolved.region ?? resolved.maximize().region ?? "";
    if (new Set(["AE", "AF", "BH", "DJ", "DZ", "EG", "IQ", "IR", "JO", "KW", "LY", "OM", "QA", "SD", "SY"]).has(region)) return 6;
    if (new Set(["AG", "AR", "AS", "AU", "BR", "BS", "BT", "BW", "BZ", "CA", "CN", "CO", "DM", "DO", "ET", "GT", "GU", "HK", "HN", "ID", "IL", "IN", "JM", "JP", "KE", "KH", "KR", "LA", "MH", "MM", "MO", "MT", "MX", "MZ", "NI", "NP", "NZ", "PA", "PE", "PH", "PK", "PR", "PT", "PY", "SA", "SG", "SV", "TH", "TT", "TW", "UM", "US", "VE", "VI", "WS", "YE", "ZA", "ZW"]).has(region)) return 0;
  } catch { /* malformed locale: deterministic Monday fallback */ }
  return 1;
}

function calendarLocalDate(date: CalendarDate): Date {
  return prolepticLocalDate(date.year, date.month - 1, date.day);
}

function todayParts(): CalendarDate {
  const today = new Date();
  return { year: today.getFullYear(), month: today.getMonth() + 1, day: today.getDate() };
}

function compareDate(a: CalendarDate, b: CalendarDate): number {
  return a.year - b.year || a.month - b.month || a.day - b.day;
}

function shiftDate(date: CalendarDate, days: number): CalendarDate {
  const shifted = prolepticLocalDate(date.year, date.month - 1, date.day + days);
  return { year: shifted.getFullYear(), month: shifted.getMonth() + 1, day: shifted.getDate() };
}

function shiftMonth(date: CalendarDate, months: number): CalendarDate {
  const shifted = prolepticLocalDate(date.year, date.month - 1 + months, 1);
  const year = shifted.getFullYear();
  const month = shifted.getMonth() + 1;
  return { year, month, day: Math.min(date.day, daysInMonth(year, month)) };
}

function localeName(): string {
  return normalizeCalendarLocale(document.documentElement.lang || navigator.languages?.[0] || navigator.language || "en");
}

export const calendar: ElementFactory = (node, _ctx, api) => {
  const root = el("section", "dsx-calendar");
  const header = el("div", "dsx-calendar-header");
  const previous = el("button", "dsx-calendar-page dsx-calendar-previous");
  const title = el("h2", "dsx-calendar-title");
  const next = el("button", "dsx-calendar-page dsx-calendar-next");
  const weekdayRow = el("div", "dsx-calendar-weekdays");
  const grid = el("div", "dsx-calendar-grid");
  const locale = localeName();
  const firstWeekday = calendarFirstWeekday(locale);
  const initial = todayParts();
  let displayed = { year: initial.year, month: initial.month };
  let selected: CalendarDate | null = null;
  let minimum: CalendarDate | null = parseCalendarDate(node.attrs["min"]);
  let maximum: CalendarDate | null = parseCalendarDate(node.attrs["max"]);
  let marks = new Map<string, string>();
  let markDateField = node.attrs["markDateField"] ?? "date";
  let markColorField = node.attrs["markColorField"] ?? "color";
  let markRows: unknown = [];
  let globallyDisabled = false;
  let focusAfterRender: string | null = null;
  let applyDisabled = (): void => {};
  let boundInitialized = false;

  previous.type = "button";
  previous.setAttribute("aria-label", "Previous month");
  previous.textContent = "‹";
  next.type = "button";
  next.setAttribute("aria-label", "Next month");
  next.textContent = "›";
  title.setAttribute("aria-live", "polite");
  weekdayRow.setAttribute("role", "row");
  grid.setAttribute("role", "grid");
  header.append(previous, title, next);
  root.append(header, weekdayRow, grid);
  bindTint(root, node, api);

  const rebuildMarks = (): void => {
    const nextMarks = new Map<string, string>();
    if (Array.isArray(markRows)) {
      for (const raw of markRows.slice(0, DATA_CONTROL_LIMITS.marks)) {
        if (!isDict(raw)) continue;
        const date = parseCalendarDate((raw as Dict)[markDateField]);
        if (date === null) continue;
        const authored = boundedText((raw as Dict)[markColorField]);
        nextMarks.set(calendarDateKey(date), authored.length > 0 ? colorValue(authored) : "var(--dsx-data-tint)");
      }
    }
    marks = nextMarks;
  };

  const inRange = (date: CalendarDate): boolean =>
    date.year >= 1 && date.year <= 9_999
    && (minimum === null || compareDate(date, minimum) >= 0)
    && (maximum === null || compareDate(date, maximum) <= 0);

  const canShowMonth = (year: number, month: number): boolean => {
    if (year < 1 || year > 9_999 || month < 1 || month > 12) return false;
    const first = { year, month, day: 1 };
    const last = { year, month, day: daysInMonth(year, month) };
    return (minimum === null || compareDate(last, minimum) >= 0) && (maximum === null || compareDate(first, maximum) <= 0);
  };

  const render = (): void => {
    const monthDate = prolepticLocalDate(displayed.year, displayed.month - 1, 1);
    const monthName = new Intl.DateTimeFormat(locale, { year: "numeric", month: "long" }).format(monthDate);
    title.textContent = monthName;
    grid.setAttribute("aria-label", monthName);
    root.setAttribute("data-dsx-month", `${String(displayed.year).padStart(4, "0")}-${String(displayed.month).padStart(2, "0")}`);

    const weekdays: HTMLElement[] = [];
    for (let index = 0; index < 7; index += 1) {
      const weekday = (firstWeekday + index) % 7;
      const date = new Date(2024, 0, 7 + weekday, 12);
      const cell = el("span", "dsx-calendar-weekday");
      cell.setAttribute("role", "columnheader");
      cell.setAttribute("aria-label", new Intl.DateTimeFormat(locale, { weekday: "long" }).format(date));
      cell.textContent = new Intl.DateTimeFormat(locale, { weekday: "narrow" }).format(date);
      weekdays.push(cell);
    }
    weekdayRow.replaceChildren(...weekdays);

    const month = calendarMonthGrid(displayed.year, displayed.month, firstWeekday);
    const cells: HTMLElement[] = [];
    for (let blank = 0; blank < month.leading; blank += 1) {
      const cell = el("span", "dsx-calendar-cell dsx-calendar-blank");
      cell.setAttribute("role", "gridcell");
      cell.setAttribute("aria-hidden", "true");
      cells.push(cell);
    }
    for (let day = 1; day <= month.days; day += 1) {
      const date = { year: displayed.year, month: displayed.month, day };
      const key = calendarDateKey(date);
      const active = selected !== null && compareDate(selected, date) === 0;
      const today = compareDate(todayParts(), date) === 0;
      const disabled = globallyDisabled || !inRange(date);
      const cell = el("span", "dsx-calendar-cell");
      const button = el("button", "dsx-calendar-day");
      const number = el("span", "dsx-calendar-day-number");
      button.type = "button";
      button.dataset["dsxDate"] = key;
      button.dataset["dsxIntrinsicDisabled"] = String(!inRange(date));
      button.disabled = disabled;
      button.setAttribute("aria-label", new Intl.DateTimeFormat(locale, { dateStyle: "full" }).format(calendarLocalDate(date)));
      button.setAttribute("aria-pressed", String(active));
      button.setAttribute("data-dsx-selected", String(active));
      button.setAttribute("data-dsx-today", String(today));
      button.tabIndex = active || (selected === null && day === 1) ? 0 : -1;
      number.textContent = String(day);
      button.appendChild(number);
      const mark = marks.get(key);
      if (mark !== undefined) {
        const dot = el("span", "dsx-calendar-mark");
        dot.setAttribute("aria-hidden", "true");
        dot.style.setProperty("--dsx-calendar-mark", mark);
        button.appendChild(dot);
      }
      button.addEventListener("click", () => {
        if (disabled) return;
        const previousValue = selected === null ? "" : calendarDateKey(selected);
        selected = date;
        render();
        emitChange(api, node.attrs["bind"], previousValue, key);
      });
      button.addEventListener("keydown", (event) => {
        const rtl = getComputedStyle(root).direction === "rtl";
        const offset = event.key === "ArrowLeft" ? (rtl ? 1 : -1)
          : event.key === "ArrowRight" ? (rtl ? -1 : 1)
          : event.key === "ArrowUp" ? -7
          : event.key === "ArrowDown" ? 7
          : event.key === "Home" ? -((calendarLocalDate(date).getDay() - firstWeekday + 7) % 7)
          : event.key === "End" ? 6 - ((calendarLocalDate(date).getDay() - firstWeekday + 7) % 7)
          : null;
        if (offset === null && event.key !== "PageUp" && event.key !== "PageDown") return;
        event.preventDefault();
        const target = event.key === "PageUp" || event.key === "PageDown"
          ? shiftMonth(date, event.key === "PageUp" ? -1 : 1)
          : shiftDate(date, offset ?? 0);
        const normalized = target;
        if (!inRange(normalized)) return;
        displayed = { year: normalized.year, month: normalized.month };
        focusAfterRender = calendarDateKey(normalized);
        render();
      });
      cell.setAttribute("role", "gridcell");
      cell.setAttribute("aria-selected", String(active));
      cell.appendChild(button);
      cells.push(cell);
    }
    grid.replaceChildren(...cells);
    const previousDate = prolepticLocalDate(displayed.year, displayed.month - 2, 1);
    const nextDate = prolepticLocalDate(displayed.year, displayed.month, 1);
    const previousUnavailable = !canShowMonth(previousDate.getFullYear(), previousDate.getMonth() + 1);
    const nextUnavailable = !canShowMonth(nextDate.getFullYear(), nextDate.getMonth() + 1);
    previous.dataset["dsxIntrinsicDisabled"] = String(previousUnavailable);
    next.dataset["dsxIntrinsicDisabled"] = String(nextUnavailable);
    previous.disabled = globallyDisabled || previousUnavailable;
    next.disabled = globallyDisabled || nextUnavailable;
    applyDisabled();
    if (focusAfterRender !== null) {
      const wanted = focusAfterRender;
      focusAfterRender = null;
      queueMicrotask(() => grid.querySelector<HTMLButtonElement>(`[data-dsx-date="${wanted}"]`)?.focus());
    }
  };

  const page = (delta: number): void => {
    const target = prolepticLocalDate(displayed.year, displayed.month - 1 + delta, 1);
    const year = target.getFullYear();
    const month = target.getMonth() + 1;
    if (!canShowMonth(year, month)) return;
    displayed = { year, month };
    render();
    api.handler("month", { month: `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}` });
  };
  previous.addEventListener("click", () => page(-1));
  next.addEventListener("click", () => page(1));

  api.bindValue(node.attrs["bind"], (value) => {
    const nextSelected = parseCalendarDate(value);
    if (!boundInitialized && nextSelected !== null) displayed = { year: nextSelected.year, month: nextSelected.month };
    boundInitialized = true;
    selected = nextSelected;
    render();
  });
  if (node.attrs["min"] !== undefined) api.bindText(node.attrs["min"], (value) => { minimum = parseCalendarDate(value); render(); });
  if (node.attrs["max"] !== undefined) api.bindText(node.attrs["max"], (value) => { maximum = parseCalendarDate(value); render(); });
  if (node.attrs["markDateField"] !== undefined) api.bindText(node.attrs["markDateField"], (value) => { markDateField = boundedText(value) || "date"; rebuildMarks(); render(); });
  if (node.attrs["markColorField"] !== undefined) api.bindText(node.attrs["markColorField"], (value) => { markColorField = boundedText(value) || "color"; rebuildMarks(); render(); });
  api.bindValue(node.attrs["marks"], (value) => { markRows = value; rebuildMarks(); render(); });
  applyDisabled = bindDisabled(root, node, api, () => [previous, next, ...grid.querySelectorAll<HTMLButtonElement>("button")]);
  render();
  return root;
};

// MARK: - Radio group

export const RadioGroup: ElementFactory = (node, _ctx, api) => {
  const root = el("div", "dsx-radio-group");
  const name = `dsx-radio-${++dataControlSequence}`;
  root.setAttribute("role", "radiogroup");
  root.setAttribute("aria-label", node.attrs["a11yLabel"] ?? node.attrs["label"] ?? "Options");
  bindTint(root, node, api);
  let options: DataControlOption[] = [];
  let selected = "";
  let inputs: HTMLInputElement[] = [];
  let applyDisabled = (): void => {};

  const reflect = (): void => {
    inputs.forEach((input) => { input.checked = input.value === selected; });
  };
  const render = (): void => {
    const focusedValue = root.contains(document.activeElement) && document.activeElement instanceof HTMLInputElement
      ? document.activeElement.value : null;
    inputs = [];
    const rows = options.map((option) => {
      const row = el("label", "dsx-radio-option");
      const input = el("input", "dsx-radio-input");
      const mark = el("span", "dsx-radio-mark");
      const label = el("span", "dsx-radio-label");
      input.type = "radio";
      input.name = name;
      input.value = option.value;
      label.textContent = option.label;
      mark.setAttribute("aria-hidden", "true");
      input.addEventListener("change", () => {
        if (!input.checked) return;
        const previous = selected;
        selected = option.value;
        reflect();
        emitChange(api, node.attrs["bind"], previous, selected);
      });
      row.append(input, mark, label);
      inputs.push(input);
      return row;
    });
    root.replaceChildren(...rows);
    reflect();
    applyDisabled();
    if (focusedValue !== null) queueMicrotask(() => inputs.find((input) => input.value === focusedValue)?.focus());
  };
  bindOptions(node, api, (next) => { options = next; render(); });
  api.bindValue(node.attrs["bind"], (value) => { selected = boundedText(value); reflect(); });
  applyDisabled = bindDisabled(root, node, api, () => inputs);
  return root;
};

// MARK: - Connected segmented buttons

export function normalizeSegmentedSelection(value: unknown, options: readonly string[]): string[] {
  const selected = new Set(parseDataControlCsv(string(value), DATA_CONTROL_LIMITS.options));
  return options.filter((option, index) => options.indexOf(option) === index && selected.has(option));
}

export const segmentedButton: ElementFactory = (node, _ctx, api) => {
  const root = el("div", "dsx-segmented-button");
  root.setAttribute("data-dsx-component", "segmented-button");
  const multiple = (node.attrs["multiple"] ?? "true").trim().toLowerCase() !== "false";
  root.setAttribute("role", multiple ? "group" : "radiogroup");
  root.setAttribute("aria-label", node.attrs["a11yLabel"] ?? node.attrs["label"] ?? "Options");
  root.setAttribute("data-dsx-multiple", String(multiple));
  bindTint(root, node, api);
  let ids: string[] = [];
  let icons: string[] = [];
  let selected: string[] = [];
  let buttons: HTMLButtonElement[] = [];
  let applyDisabled = (): void => {};

  const reflect = (): void => {
    buttons.forEach((button, index) => {
      const active = selected.includes(ids[index] ?? "");
      button.setAttribute("data-dsx-selected", String(active));
      if (multiple) button.setAttribute("aria-pressed", String(active));
      else {
        button.setAttribute("role", "radio");
        button.setAttribute("aria-checked", String(active));
        button.tabIndex = active || (selected.length === 0 && index === 0) ? 0 : -1;
      }
    });
  };
  const commit = (id: string): void => {
    const previous = selected.join(",");
    if (multiple) {
      const set = new Set(selected);
      if (set.has(id)) set.delete(id); else set.add(id);
      selected = ids.filter((option) => set.has(option));
    } else {
      selected = selected.includes(id) ? [] : [id];
    }
    reflect();
    emitChange(api, node.attrs["bind"], previous, selected.join(","));
  };
  const render = (): void => {
    buttons = ids.map((id, index) => {
      const button = el("button", "dsx-segmented-button-item");
      button.type = "button";
      button.setAttribute("data-dsx-part", "segment");
      const icon = icons[index];
      if (icon !== undefined && icon.length > 0) {
        const iconHost = el("span", "dsx-segmented-button-icon");
        iconHost.setAttribute("data-dsx-part", "icon");
        iconHost.appendChild(iconSvg(icon, 18));
        button.appendChild(iconHost);
      }
      const label = el("span", "dsx-segmented-button-label");
      label.setAttribute("data-dsx-part", "label");
      label.textContent = id;
      button.appendChild(label);
      button.addEventListener("click", () => commit(id));
      if (!multiple) {
        button.addEventListener("keydown", (event) => {
          const rtl = getComputedStyle(root).direction === "rtl";
          const next = event.key === "Home" ? 0
            : event.key === "End" ? buttons.length - 1
            : event.key === "ArrowRight" ? (index + (rtl ? -1 : 1) + buttons.length) % buttons.length
            : event.key === "ArrowLeft" ? (index + (rtl ? 1 : -1) + buttons.length) % buttons.length
            : null;
          if (next === null) return;
          event.preventDefault();
          const nextId = ids[next];
          if (nextId !== undefined) {
            const previous = selected.join(",");
            selected = [nextId];
            reflect();
            emitChange(api, node.attrs["bind"], previous, nextId);
            buttons[next]?.focus();
          }
        });
      }
      return button;
    });
    root.replaceChildren(...buttons);
    reflect();
    applyDisabled();
  };
  api.bindText(node.attrs["options"] ?? "", (value) => {
    ids = parseDataControlCsv(value);
    selected = normalizeSegmentedSelection(selected.join(","), ids);
    render();
  });
  api.bindText(node.attrs["icons"] ?? "", (value) => { icons = parseDataControlCsv(value); render(); });
  api.bindValue(node.attrs["bind"], (value) => { selected = normalizeSegmentedSelection(value, ids); reflect(); });
  applyDisabled = bindDisabled(root, node, api, () => buttons);
  return root;
};

// MARK: - Refreshable

export const refreshable: ElementFactory = (node, ctx, api) => {
  const root = el("section", "dsx-refreshable");
  const affordance = el("div", "dsx-refresh-affordance");
  const button = el("button", "dsx-refresh-button");
  const symbol = el("span", "dsx-refresh-symbol");
  const status = el("span", "dsx-refresh-status");
  const viewport = el("div", "dsx-refresh-viewport");
  button.type = "button";
  button.setAttribute("aria-label", node.attrs["a11yLabel"] ?? "Refresh");
  symbol.textContent = "↻";
  symbol.setAttribute("aria-hidden", "true");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  affordance.append(button, status);
  button.appendChild(symbol);
  api.children(viewport);
  root.append(affordance, viewport);

  let refreshing = false;
  let busy = false;
  let busyGateOpen = false;
  let finishTimer: ReturnType<typeof setTimeout> | null = null;
  let busyStartTimer: ReturnType<typeof setTimeout> | null = null;
  let busyMaximumTimer: ReturnType<typeof setTimeout> | null = null;
  let pointerId: number | null = null;
  let pointerStart = 0;
  let touchStart: number | null = null;
  let pull = 0;

  // THE OVERSCROLL LAW, from the shared motion kernel (ui-motion.md): the finger travel
  // is compressed by the pinned rubber band f(x) = (1 − 1/(x·0.55/d + 1))·d with d =
  // refreshPullMaximum, so the pull ASYMPTOTES to the ceiling instead of hitting a wall.
  // For a small pull this is the same 0.55 damping this control has always used (the
  // constant it hard-coded IS the rubber-band c) — the divergence only appears once the
  // finger travels far, where a real overscroll gets progressively stiffer.
  const setPull = (value: number): void => {
    pull = Math.min(Math.max(value, 0), DATA_CONTROL_LIMITS.refreshPullMaximum);
    root.style.setProperty("--dsx-refresh-pull", `${pull}px`);
    root.setAttribute("data-dsx-armed", String(pull >= DATA_CONTROL_LIMITS.refreshPullPixels));
  };
  const clearTimers = (): void => {
    if (finishTimer !== null) clearTimeout(finishTimer);
    if (busyStartTimer !== null) clearTimeout(busyStartTimer);
    if (busyMaximumTimer !== null) clearTimeout(busyMaximumTimer);
    finishTimer = busyStartTimer = busyMaximumTimer = null;
  };
  const finish = (timedOut = false): void => {
    if (!refreshing) return;
    clearTimers();
    refreshing = false;
    busyGateOpen = false;
    button.disabled = false;
    root.setAttribute("data-dsx-refreshing", "false");
    root.setAttribute("aria-busy", String(busy));
    status.textContent = timedOut ? "Refresh timed out" : "";
    setPull(0);
    if (timedOut) api.handler("timeout");
  };
  const begin = (): void => {
    if (refreshing) return;
    refreshing = true;
    busyGateOpen = false;
    button.disabled = true;
    root.setAttribute("data-dsx-refreshing", "true");
    root.setAttribute("aria-busy", "true");
    status.textContent = "Refreshing";
    setPull(0);
    api.handler("refresh");
    if (node.attrs["busy"] === undefined) {
      finishTimer = setTimeout(() => finish(), DATA_CONTROL_LIMITS.refreshGraceMs);
    } else {
      busyStartTimer = setTimeout(() => {
        busyStartTimer = null;
        busyGateOpen = true;
        if (!busy) finish();
      }, DATA_CONTROL_LIMITS.refreshBusyStartMs);
      busyMaximumTimer = setTimeout(() => finish(true), DATA_CONTROL_LIMITS.refreshBusyMaximumMs);
    }
  };
  button.addEventListener("click", begin);
  if (node.attrs["busy"] !== undefined) {
    api.bindValue(node.attrs["busy"], (value) => {
      busy = truthy(value);
      if (!refreshing) root.setAttribute("aria-busy", String(busy));
      if (refreshing && busyGateOpen && !busy) finish();
    });
  } else root.setAttribute("aria-busy", "false");

  viewport.addEventListener("pointerdown", (event) => {
    if (event.pointerType === "touch" || !event.isPrimary || viewport.scrollTop > 0) return;
    pointerId = event.pointerId;
    pointerStart = event.clientY;
    try { viewport.setPointerCapture(event.pointerId); } catch { /* detached pointer */ }
  });
  viewport.addEventListener("pointermove", (event) => {
    if (event.pointerId !== pointerId || viewport.scrollTop > 0) return;
    setPull(rubberBand(event.clientY - pointerStart, DATA_CONTROL_LIMITS.refreshPullMaximum));
    if (pull > 0 && event.cancelable) event.preventDefault();
  });
  const endPointer = (event: PointerEvent): void => {
    if (event.pointerId !== pointerId) return;
    pointerId = null;
    if (pull >= DATA_CONTROL_LIMITS.refreshPullPixels) begin(); else setPull(0);
  };
  viewport.addEventListener("pointerup", endPointer);
  viewport.addEventListener("pointercancel", endPointer);
  viewport.addEventListener("touchstart", (event) => {
    touchStart = viewport.scrollTop <= 0 ? event.touches[0]?.clientY ?? null : null;
  }, { passive: true });
  viewport.addEventListener("touchmove", (event) => {
    if (touchStart === null || viewport.scrollTop > 0) return;
    const y = event.touches[0]?.clientY;
    if (y === undefined) return;
    setPull(rubberBand(y - touchStart, DATA_CONTROL_LIMITS.refreshPullMaximum));
    if (pull > 0 && event.cancelable) event.preventDefault();
  }, { passive: false });
  viewport.addEventListener("touchend", () => {
    touchStart = null;
    if (pull >= DATA_CONTROL_LIMITS.refreshPullPixels) begin(); else setPull(0);
  }, { passive: true });
  viewport.addEventListener("touchcancel", () => { touchStart = null; setPull(0); }, { passive: true });
  ctx.disposers.push(clearTimers);
  root.setAttribute("data-dsx-refreshing", "false");
  setPull(0);
  return root;
};

export const DATA_CONTROL_ELEMENTS: Readonly<Record<string, ElementFactory>> = Object.freeze({
  calendar,
  segmentedButton,
  refreshable,
  refresh: refreshable,
});

export const DATA_CONTROL_GLOBAL_ELEMENTS: Readonly<Record<string, ElementFactory>> = Object.freeze({
  Table,
  RadioGroup,
});

export const DATA_CONTROL_TAGS: ReadonlySet<string> = new Set([
  ...Object.keys(DATA_CONTROL_ELEMENTS), ...Object.keys(DATA_CONTROL_GLOBAL_ELEMENTS),
]);

export function registerDataControls(): void {
  Object.assign(ELEMENTS, DATA_CONTROL_ELEMENTS);
  Object.assign(GLOBAL_ELEMENTS, DATA_CONTROL_GLOBAL_ELEMENTS);
}

export const DATA_CONTROLS_CSS = `@layer dsx-elements {
  .dsx-table-frame, .dsx-calendar, .dsx-radio-group, .dsx-segmented-button, .dsx-refreshable {
    --dsx-data-tint: var(--dsx-accent);
    box-sizing: border-box;
    min-width: 0;
    color: var(--dsx-label);
    font-family: var(--dsx-font);
  }

  .dsx-table-frame {
    width: 100%;
    overflow: auto;
    border: 1px solid var(--dsx-separator);
    border-radius: var(--dsx-radius);
    background: var(--dsx-secondary-grouped-background);
    scrollbar-gutter: stable;
    overscroll-behavior: contain;
  }
  .dsx-table-frame:focus-visible { outline: none; box-shadow: var(--dsx-focus-ring); }
  .dsx-table { width: 100%; border-collapse: collapse; table-layout: fixed; color: var(--dsx-table-color, var(--dsx-label)); font: inherit; }
  .dsx-table th, .dsx-table td {
    box-sizing: border-box;
    min-width: 7rem;
    padding-inline: 8px;
    overflow: hidden;
    border-block-end: 1px solid color-mix(in srgb, var(--dsx-separator) 58%, transparent);
    text-align: start;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .dsx-table th { height: 40px; color: var(--dsx-secondary-label); font-size: 13px; font-weight: 650; }
  .dsx-table td { height: 44px; font-size: 15px; }
  .dsx-table tbody tr:last-child td { border-block-end: 0; }
  .dsx-table tbody tr { content-visibility: auto; contain-intrinsic-block-size: 44px; }

  .dsx-calendar { display: grid; gap: 10px; width: 100%; max-width: 32rem; }
  .dsx-calendar-header { display: grid; grid-template-columns: 44px minmax(0, 1fr) 44px; align-items: center; }
  .dsx-calendar-title { margin: 0; text-align: center; font-size: 1rem; font-weight: 650; line-height: 1.3; }
  .dsx-calendar-page, .dsx-calendar-day {
    appearance: none;
    margin: 0;
    border: 0;
    color: inherit;
    background: transparent;
    font: inherit;
    cursor: pointer;
  }
  .dsx-calendar-page { min-width: 44px; min-height: 44px; color: var(--dsx-data-tint); font-size: 1.5rem; line-height: 1; }
  .dsx-calendar-page:disabled, .dsx-calendar-day:disabled { cursor: not-allowed; opacity: .38; }
  .dsx-calendar-page:focus-visible, .dsx-calendar-day:focus-visible { outline: none; box-shadow: var(--dsx-focus-ring); }
  .dsx-calendar-weekdays, .dsx-calendar-grid { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); }
  .dsx-calendar-weekday {
    display: grid;
    place-items: center;
    min-height: 24px;
    color: var(--dsx-secondary-label);
    font-size: .6875rem;
    font-weight: 650;
  }
  .dsx-calendar-cell { display: grid; place-items: center; min-width: 0; min-height: 44px; }
  .dsx-calendar-day { position: relative; display: grid; place-items: center; width: 100%; min-width: 44px; min-height: 44px; border-radius: var(--dsx-radius-sm); }
  .dsx-calendar-day-number { display: grid; place-items: center; width: 34px; height: 34px; border: 1px solid transparent; border-radius: 50%; }
  .dsx-calendar-day[data-dsx-selected="true"] .dsx-calendar-day-number { color: var(--dsx-on-accent); background: var(--dsx-data-tint); font-weight: 700; }
  .dsx-calendar-day[data-dsx-today="true"]:not([data-dsx-selected="true"]) .dsx-calendar-day-number { border-color: var(--dsx-data-tint); }
  .dsx-calendar-mark { position: absolute; inset: auto auto 2px 50%; width: 5px; height: 5px; border-radius: 50%; background: var(--dsx-calendar-mark, var(--dsx-data-tint)); transform: translateX(-50%); }

  .dsx-radio-group { display: grid; gap: 12px; }
  .dsx-radio-option { display: grid; grid-template-columns: 22px minmax(0, 1fr); align-items: center; gap: 10px; min-height: 44px; cursor: pointer; }
  .dsx-radio-input { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  .dsx-radio-mark { display: grid; place-items: center; box-sizing: border-box; width: 20px; height: 20px; border: 1.5px solid var(--dsx-secondary-label); border-radius: 50%; }
  .dsx-radio-mark::after { content: ""; width: 10px; height: 10px; border-radius: 50%; background: var(--dsx-data-tint); transform: scale(0); }
  .dsx-radio-input:checked + .dsx-radio-mark { border-color: var(--dsx-data-tint); }
  .dsx-radio-input:checked + .dsx-radio-mark::after { transform: scale(1); }
  .dsx-radio-input:focus-visible + .dsx-radio-mark { box-shadow: var(--dsx-focus-ring); }
  .dsx-radio-group[data-dsx-disabled="true"] { opacity: .48; }

  .dsx-segmented-button {
    display: inline-flex;
    gap: 2px;
    max-width: 100%;
    min-height: 48px;
    padding: 2px;
    overflow-x: auto;
    border: 0;
    border-radius: var(--dsx-radius);
    background: var(--dsx-surface-recessed);
    box-shadow:
      inset 0 0 0 var(--dsx-hairline) var(--dsx-outline-soft),
      inset 0 1px 2px color-mix(in srgb, var(--dsx-label) 7%, transparent);
  }
  .dsx-segmented-button-item {
    appearance: none;
    display: inline-flex;
    flex: 1 1 0;
    align-items: center;
    justify-content: center;
    gap: 6px;
    min-width: 44px;
    min-height: 44px;
    padding: 0 14px;
    border: 0;
    border-radius: calc(var(--dsx-radius) - 2px);
    color: var(--dsx-secondary-label);
    background: transparent;
    font: 600 15px/1.2 var(--dsx-font);
    white-space: nowrap;
    cursor: pointer;
    transition:
      color var(--dsx-motion-fast) ease,
      background-color var(--dsx-motion-fast) ease,
      opacity var(--dsx-motion-fast) ease;
  }
  .dsx-segmented-button-item[data-dsx-selected="true"] {
    color: var(--dsx-label);
    background: linear-gradient(165deg, var(--dsx-surface-highlight), var(--dsx-surface-level-3));
    box-shadow:
      inset 0 0 0 var(--dsx-hairline) var(--dsx-outline-soft),
      inset 0 1px 0 var(--dsx-inner-highlight),
      0 1px 2px color-mix(in srgb, var(--dsx-label) 12%, transparent);
  }
  .dsx-segmented-button-item:focus-visible {
    position: relative;
    z-index: 1;
    outline: none;
    box-shadow: inset 0 0 0 3px var(--dsx-data-tint);
  }
  .dsx-segmented-button-item:disabled { cursor: not-allowed; opacity: .48; }
  .dsx-segmented-button-item:not(:disabled):active { opacity: .76; }
  .dsx-segmented-button-icon { display: inline-flex; }

  .dsx-refreshable { position: relative; display: grid; grid-template-rows: auto minmax(0, 1fr); min-height: 0; overflow: hidden; }
  .dsx-refresh-affordance { display: flex; align-items: center; justify-content: center; gap: 8px; min-height: var(--dsx-refresh-pull, 0px); overflow: hidden; color: var(--dsx-secondary-label); }
  .dsx-refresh-button { appearance: none; display: grid; place-items: center; width: 44px; height: 44px; margin: 0; padding: 0; border: 1px solid var(--dsx-separator); border-radius: 50%; color: var(--dsx-data-tint); background: var(--dsx-secondary-grouped-background); font: inherit; cursor: pointer; }
  .dsx-refresh-button:focus-visible { outline: none; box-shadow: var(--dsx-focus-ring); }
  .dsx-refresh-button:disabled { opacity: .65; cursor: wait; }
  .dsx-refresh-status { font-size: .8125rem; }
  .dsx-refresh-symbol { font-size: 1.2rem; line-height: 1; }
  .dsx-refreshable[data-dsx-refreshing="true"] .dsx-refresh-symbol { animation: dsx-refresh-spin .8s linear infinite; }
  .dsx-refreshable[data-dsx-armed="true"] .dsx-refresh-symbol { transform: rotate(180deg); }
  .dsx-refresh-viewport { min-width: 0; min-height: 0; overflow: auto; overscroll-behavior-y: contain; -webkit-overflow-scrolling: touch; }
  @keyframes dsx-refresh-spin { to { transform: rotate(360deg); } }

  @media (min-width: 64rem) and (hover: hover) and (pointer: fine) {
    .dsx-calendar-page:hover:not(:disabled), .dsx-calendar-day:hover:not(:disabled), .dsx-refresh-button:hover:not(:disabled) { background: var(--dsx-fill); }
    .dsx-radio-option:hover { color: var(--dsx-data-tint); }
    .dsx-segmented-button { min-height: 40px; }
    .dsx-segmented-button-item { min-height: 36px; padding-inline: 10px; font-size: .8125rem; }
    .dsx-segmented-button-item:not([data-dsx-selected="true"]):not(:disabled):hover {
      color: var(--dsx-label);
      background: var(--dsx-fill);
    }
    .dsx-table td { height: 38px; font-size: .875rem; }
    .dsx-table tbody tr { contain-intrinsic-block-size: 38px; }
    .dsx-refresh-button { width: 36px; height: 36px; }
  }
  @media (prefers-reduced-motion: reduce) {
    .dsx-refreshable[data-dsx-refreshing="true"] .dsx-refresh-symbol { animation: none; }
    .dsx-segmented-button-item { transition: none; }
  }
  @media (forced-colors: active) {
    .dsx-table-frame, .dsx-segmented-button, .dsx-radio-mark, .dsx-refresh-button { border-color: CanvasText; }
    .dsx-calendar-day[data-dsx-selected="true"] .dsx-calendar-day-number,
    .dsx-segmented-button-item[data-dsx-selected="true"] { color: HighlightText; background: Highlight; }
    .dsx-calendar-page:focus-visible, .dsx-calendar-day:focus-visible,
    .dsx-radio-input:focus-visible + .dsx-radio-mark, .dsx-segmented-button-item:focus-visible,
    .dsx-refresh-button:focus-visible, .dsx-table-frame:focus-visible { outline: 2px solid Highlight; outline-offset: 2px; box-shadow: none; }
  }
}`;
