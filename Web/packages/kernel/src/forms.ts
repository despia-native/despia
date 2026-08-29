//
//  forms.ts — THE FORMS PURE CORE (U08). The input MASK engine, E.164 parse/format/
//  validate over the one shared country table, the DATE-RANGE validity fold, form
//  VALIDITY aggregation with the submit gate, and the <multiselect> / <tagsfield> folds
//  with the accessibility announcements all three renderers must speak identically.
//
//  Corpus: OpenSource/Conformance/forms/{mask,countries,phone,daterange,validation,
//  composites}.json, executed here by packages/kernel/test/forms-conformance.test.ts,
//  by the Kotlin twin (:core FormsConformanceTest, Forms.kt) and by the Swift twin
//  (record lane, FormsConformance.swift / Forms.swift). Three implementations of
//  "where is the caret after an edit in the middle of a masked value" would be three
//  different bugs; there is one answer and it is data.
//
//  PURE by construction: no DOM, no Intl, no Date, no RegExp outside the declared
//  validation rules, no imports. Everything a renderer needs is a function of its
//  arguments, which is what lets one corpus judge three runtimes.
//

// ─────────────────────────────────────────────────────────────────────────────
// MASK
// ─────────────────────────────────────────────────────────────────────────────

/** `#` a digit · `A` an ASCII letter · `*` an ASCII letter or digit · anything else a
 *  literal (`\x` escapes a placeholder character into a literal). */
export type MaskTokenKind = "#" | "A" | "*" | "lit";

export type MaskToken = Readonly<{ kind: MaskTokenKind; ch: string }>;

export type MaskEdit = Readonly<{
  /** The corrected display text. */
  display: string;
  /** Where the caret belongs in `display` (the part naive implementations get wrong). */
  caret: number;
  /** The UNMASKED value — what `bind` receives. */
  raw: string;
  /** Every placeholder is filled. */
  complete: boolean;
}>;

const ZERO = 48, NINE = 57, UPPER_A = 65, UPPER_Z = 90, LOWER_A = 97, LOWER_Z = 122;

function isDigit(ch: string): boolean { const c = ch.charCodeAt(0); return c >= ZERO && c <= NINE; }
function isLetter(ch: string): boolean {
  const c = ch.charCodeAt(0);
  return (c >= UPPER_A && c <= UPPER_Z) || (c >= LOWER_A && c <= LOWER_Z);
}

export function maskTokens(mask: string): MaskToken[] {
  const out: MaskToken[] = [];
  for (let i = 0; i < mask.length; i += 1) {
    const ch = mask[i]!;
    if (ch === "\\" && i + 1 < mask.length) { out.push({ kind: "lit", ch: mask[i + 1]! }); i += 1; continue; }
    if (ch === "#" || ch === "A" || ch === "*") out.push({ kind: ch, ch });
    else out.push({ kind: "lit", ch });
  }
  return out;
}

function slotAccepts(kind: MaskTokenKind, ch: string): boolean {
  if (kind === "#") return isDigit(ch);
  if (kind === "A") return isLetter(ch);
  if (kind === "*") return isDigit(ch) || isLetter(ch);
  return false;
}

/** The number of placeholder slots — the mask's implicit maxLength. */
export function maskCapacity(mask: string): number {
  let n = 0;
  for (const t of maskTokens(mask)) if (t.kind !== "lit") n += 1;
  return n;
}

/** THE EXTRACTION LAW: significant iff SOME placeholder class in the mask accepts it. */
export function maskSignificant(tokens: readonly MaskToken[], ch: string): boolean {
  for (const t of tokens) if (t.kind !== "lit" && slotAccepts(t.kind, ch)) return true;
  return false;
}

/** The UNMASKED value of arbitrary text — literals and rejected characters fall away. */
export function maskExtract(mask: string, text: string): string {
  const tokens = maskTokens(mask);
  let out = "";
  for (const ch of text) if (maskSignificant(tokens, ch)) out += ch;
  return out;
}

type MaskPlacement = Readonly<{ display: string; sources: readonly number[] }>;

/** THE LAZY-LITERAL FORMAT LAW: a literal is emitted only while raw characters remain, so
 *  `(415` never shows a dangling `) `. A raw character the slot rejects is skipped — and
 *  `sources` records WHICH raw index landed in each slot, which is what lets the edit law
 *  keep the value and the display one thing instead of two. */
function maskPlace(mask: string, raw: string): MaskPlacement {
  const tokens = maskTokens(mask);
  const sources: number[] = [];
  let out = "", ri = 0;
  for (const t of tokens) {
    if (ri >= raw.length) break;
    if (t.kind === "lit") { out += t.ch; continue; }
    while (ri < raw.length && !slotAccepts(t.kind, raw[ri]!)) ri += 1;
    if (ri >= raw.length) break;
    out += raw[ri]!;
    sources.push(ri);
    ri += 1;
  }
  return { display: out, sources };
}

export function maskFormat(mask: string, raw: string): string {
  return maskPlace(mask, raw).display;
}

function displayIndexAfter(tokens: readonly MaskToken[], display: string, n: number): number {
  if (n <= 0) return 0;
  let seen = 0;
  for (let i = 0; i < display.length; i += 1) {
    if (maskSignificant(tokens, display[i]!)) {
      seen += 1;
      if (seen === n) return i + 1;
    }
  }
  return display.length;
}

/**
 * THE EDIT LAW. `prev[selStart:selEnd]` is replaced by `insert` — the one primitive
 * UIKit's `shouldChangeCharactersIn`, the web's `beforeinput` target range and Compose's
 * `TextFieldValue` diff all reduce to.
 *
 * THE SEPARATOR SWALLOW LAW: a deletion whose removed span holds no significant
 * character extends to swallow the nearest significant character to its LEFT, else the
 * nearest to its RIGHT. Without it, backspacing over `) ` is a no-op and the field feels
 * broken.
 */
export function maskEdit(
  mask: string, prev: string, selStart: number, selEnd: number, insert: string,
): MaskEdit {
  const tokens = maskTokens(mask);
  const n = prev.length;
  let s = Math.max(0, Math.min(selStart, n));
  let e = Math.max(s, Math.min(selEnd, n));
  if (insert === "" && e > s && maskExtract(mask, prev.slice(s, e)) === "") {
    let i = s - 1;
    while (i >= 0 && !maskSignificant(tokens, prev[i]!)) i -= 1;
    if (i >= 0) { s = i; } else {
      let j = e;
      while (j < n && !maskSignificant(tokens, prev[j]!)) j += 1;
      if (j < n) e = j + 1;
    }
  }
  const cap = maskCapacity(mask);
  const head = maskExtract(mask, prev.slice(0, s)) + maskExtract(mask, insert);
  const candidate = head + maskExtract(mask, prev.slice(e));
  // THE PLACEMENT LAW: `bind` receives the significant characters the mask ACCEPTED, never
  // the ones it had to skip. Keeping a rejected character in the value is the bug where a
  // field silently fills to capacity with text it does not show and then refuses to type.
  const placement = maskPlace(mask, candidate);
  let raw = "";
  let headPlaced = 0;
  for (const index of placement.sources) {
    raw += candidate[index]!;
    if (index < head.length) headPlaced += 1;
  }
  return {
    display: placement.display,
    caret: displayIndexAfter(tokens, placement.display, headPlaced),
    raw,
    complete: raw.length === cap,
  };
}

const MASK_CLASS_NAMES: Readonly<Record<string, readonly [string, string]>> = {
  "#": ["digit", "digits"],
  "A": ["letter", "letters"],
  "*": ["letter or digit", "letters or digits"],
};

/** A11Y: a masked field announces its EXPECTED FORMAT, not only its value. */
export function maskDescription(mask: string): string {
  const order: string[] = [];
  const counts: Record<string, number> = {};
  for (const t of maskTokens(mask)) {
    if (t.kind === "lit") continue;
    if (counts[t.kind] === undefined) { order.push(t.kind); counts[t.kind] = 0; }
    counts[t.kind] = (counts[t.kind] ?? 0) + 1;
  }
  if (order.length === 0) return `Format ${mask}`;
  const parts = order.map((k) => {
    const c = counts[k] ?? 0;
    const names = MASK_CLASS_NAMES[k] ?? ["character", "characters"];
    return `${c} ${c === 1 ? names[0] : names[1]}`;
  });
  const phrase = parts.length === 1
    ? parts[0]!
    : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]!}`;
  return `Format ${mask}, ${phrase}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// E.164 — the ONE country table
// ─────────────────────────────────────────────────────────────────────────────

export type FormsCountry = Readonly<{
  iso: string; name: string; dial: string; trunk: string;
  nsnMin: number; nsnMax: number;
  /** The national display mask, present ONLY where nsnMin === nsnMax === its capacity. */
  format: string | null;
  /** Resolves a SHARED dial code (+1 → US, +7 → RU). */
  primary: boolean;
}>;

function c(iso: string, name: string, dial: string, trunk: string,
           nsnMin: number, nsnMax: number, format: string | null, primary: boolean): FormsCountry {
  return { iso, name, dial, trunk, nsnMin, nsnMax, format, primary };
}

/** The trimmed country / dial-code table. Byte-identical to
 *  OpenSource/Conformance/forms/countries.json, which the runners assert. */
export const FORMS_COUNTRIES: readonly FormsCountry[] = Object.freeze([
  c("US", "United States", "1", "", 10, 10, "(###) ###-####", true),
  c("CA", "Canada", "1", "", 10, 10, "(###) ###-####", false),
  c("GB", "United Kingdom", "44", "0", 9, 10, null, true),
  c("IE", "Ireland", "353", "0", 7, 9, null, true),
  c("FR", "France", "33", "0", 9, 9, "# ## ## ## ##", true),
  c("DE", "Germany", "49", "0", 6, 11, null, true),
  c("AT", "Austria", "43", "0", 4, 13, null, true),
  c("CH", "Switzerland", "41", "0", 9, 9, "## ### ## ##", true),
  c("NL", "Netherlands", "31", "0", 9, 9, null, true),
  c("BE", "Belgium", "32", "0", 8, 9, null, true),
  c("LU", "Luxembourg", "352", "", 4, 11, null, true),
  c("ES", "Spain", "34", "", 9, 9, "### ## ## ##", true),
  c("PT", "Portugal", "351", "", 9, 9, "### ### ###", true),
  c("IT", "Italy", "39", "", 6, 11, null, true),
  c("GR", "Greece", "30", "", 10, 10, "### ### ####", true),
  c("SE", "Sweden", "46", "0", 7, 13, null, true),
  c("NO", "Norway", "47", "", 8, 8, "### ## ###", true),
  c("DK", "Denmark", "45", "", 8, 8, "## ## ## ##", true),
  c("FI", "Finland", "358", "0", 5, 12, null, true),
  c("IS", "Iceland", "354", "", 7, 9, null, true),
  c("PL", "Poland", "48", "", 9, 9, "### ### ###", true),
  c("CZ", "Czechia", "420", "", 9, 9, "### ### ###", true),
  c("SK", "Slovakia", "421", "0", 9, 9, "### ### ###", true),
  c("HU", "Hungary", "36", "06", 8, 9, null, true),
  c("RO", "Romania", "40", "0", 9, 9, "### ### ###", true),
  c("BG", "Bulgaria", "359", "0", 7, 9, null, true),
  c("HR", "Croatia", "385", "0", 8, 9, null, true),
  c("SI", "Slovenia", "386", "0", 8, 8, "## ### ###", true),
  c("RS", "Serbia", "381", "0", 8, 9, null, true),
  c("UA", "Ukraine", "380", "0", 9, 9, "## ### ####", true),
  c("RU", "Russia", "7", "8", 10, 10, " ### ###-##-##", true),
  c("KZ", "Kazakhstan", "7", "8", 10, 10, " ### ###-##-##", false),
  c("TR", "Turkey", "90", "0", 10, 10, "### ### ## ##", true),
  c("IL", "Israel", "972", "0", 8, 9, null, true),
  c("AE", "United Arab Emirates", "971", "0", 8, 9, null, true),
  c("SA", "Saudi Arabia", "966", "0", 8, 9, null, true),
  c("QA", "Qatar", "974", "", 8, 8, "#### ####", true),
  c("KW", "Kuwait", "965", "", 8, 8, "#### ####", true),
  c("EG", "Egypt", "20", "0", 9, 10, null, true),
  c("ZA", "South Africa", "27", "0", 9, 9, "## ### ####", true),
  c("NG", "Nigeria", "234", "0", 7, 10, null, true),
  c("KE", "Kenya", "254", "0", 9, 9, "### ######", true),
  c("GH", "Ghana", "233", "0", 9, 9, "## ### ####", true),
  c("MA", "Morocco", "212", "0", 9, 9, "### ######", true),
  c("IN", "India", "91", "0", 10, 10, "##### #####", true),
  c("PK", "Pakistan", "92", "0", 10, 10, "### #######", true),
  c("BD", "Bangladesh", "880", "0", 10, 10, null, true),
  c("LK", "Sri Lanka", "94", "0", 9, 9, "## ### ####", true),
  c("CN", "China", "86", "0", 5, 12, null, true),
  c("HK", "Hong Kong", "852", "", 8, 8, "#### ####", true),
  c("TW", "Taiwan", "886", "0", 8, 9, null, true),
  c("JP", "Japan", "81", "0", 9, 10, null, true),
  c("KR", "South Korea", "82", "0", 8, 10, null, true),
  c("SG", "Singapore", "65", "", 8, 8, "#### ####", true),
  c("MY", "Malaysia", "60", "0", 8, 10, null, true),
  c("TH", "Thailand", "66", "0", 9, 9, "## ### ####", true),
  c("VN", "Vietnam", "84", "0", 9, 10, null, true),
  c("ID", "Indonesia", "62", "0", 9, 12, null, true),
  c("PH", "Philippines", "63", "0", 10, 10, "### ### ####", true),
  c("AU", "Australia", "61", "0", 9, 9, "### ### ###", true),
  c("NZ", "New Zealand", "64", "0", 8, 10, null, true),
  c("BR", "Brazil", "55", "0", 10, 11, null, true),
  c("AR", "Argentina", "54", "0", 10, 11, null, true),
  c("CL", "Chile", "56", "", 9, 9, "# #### ####", true),
  c("CO", "Colombia", "57", "", 10, 10, "### #######", true),
  c("PE", "Peru", "51", "0", 8, 9, null, true),
  c("VE", "Venezuela", "58", "0", 10, 10, null, true),
  c("MX", "Mexico", "52", "", 10, 10, "### ### ####", true),
  c("CR", "Costa Rica", "506", "", 8, 8, "#### ####", true),
  c("PA", "Panama", "507", "", 8, 8, "#### ####", true),
]);

export const FORMS_DEFAULT_COUNTRY = "US";

const BY_ISO: ReadonlyMap<string, FormsCountry> =
  new Map(FORMS_COUNTRIES.map((x) => [x.iso, x]));

export function formsCountry(iso: string): FormsCountry | null {
  return BY_ISO.get((iso || "").toUpperCase()) ?? null;
}

/** A11Y + UI: the flag is a pure function of the ISO code, never table data. */
export function formsFlag(iso: string): string {
  const code = (iso || "").toUpperCase();
  if (code.length !== 2 || !isLetter(code[0]!) || !isLetter(code[1]!)) return "";
  return String.fromCodePoint(0x1f1e6 + (code.charCodeAt(0) - UPPER_A))
       + String.fromCodePoint(0x1f1e6 + (code.charCodeAt(1) - UPPER_A));
}

/** Longest PRIMARY dial-code prefix. A shared code resolves to its primary; refining
 *  +1 by area code is a named absence (forms/README.md). */
export function formsCountryForDial(digits: string): FormsCountry | null {
  let best: FormsCountry | null = null;
  for (const entry of FORMS_COUNTRIES) {
    if (!entry.primary) continue;
    if (!digits.startsWith(entry.dial)) continue;
    if (best === null || entry.dial.length > best.dial.length) best = entry;
  }
  return best;
}

export type PhoneValue = Readonly<{
  e164: string; national: string; country: string | null;
  dialCode: string; nsn: string; valid: boolean;
}>;

function digitsOf(text: string): string {
  let out = "";
  for (const ch of text) if (isDigit(ch)) out += ch;
  return out;
}

/** THE PARSE LAW — forms/README.md. `bind` receives `e164`. */
export function phoneParse(text: string, defaultCountry: string | null): PhoneValue {
  const source = text ?? "";
  const plus = source.trimStart().startsWith("+");
  let digits = digitsOf(source);
  let intl = plus;
  if (!plus && digits.startsWith("00")) { intl = true; digits = digits.slice(2); }

  let country: FormsCountry | null;
  let nsn: string;
  if (intl) {
    country = formsCountryForDial(digits);
    if (country === null) {
      return { e164: `+${digits}`, national: digits, country: null, dialCode: "", nsn: digits, valid: false };
    }
    nsn = digits.slice(country.dial.length);
  } else {
    country = formsCountry(defaultCountry ?? "");
    if (country === null) {
      return { e164: "", national: digits, country: null, dialCode: "", nsn: digits, valid: false };
    }
    const { trunk, dial } = country;
    if (trunk !== "" && digits.startsWith(trunk)) nsn = digits.slice(trunk.length);
    else if (trunk === "" && digits.startsWith(dial)
             && digits.length - dial.length >= country.nsnMin
             && digits.length - dial.length <= country.nsnMax) nsn = digits.slice(dial.length);
    else nsn = digits;
  }
  const national = country.trunk + (country.format !== null ? maskFormat(country.format, nsn) : nsn);
  return {
    e164: `+${country.dial}${nsn}`,
    national,
    country: country.iso,
    dialCode: country.dial,
    nsn,
    valid: nsn.length >= country.nsnMin && nsn.length <= country.nsnMax && !nsn.startsWith("0"),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// DATE RANGE — civil dates only, no timezone anywhere
// ─────────────────────────────────────────────────────────────────────────────

/** Howard Hinnant's days_from_civil: the proleptic-Gregorian day count from 1970-01-01. */
export function formsDaysFromCivil(y: number, m: number, d: number): number {
  const yy = y - (m <= 2 ? 1 : 0);
  const era = Math.floor((yy >= 0 ? yy : yy - 399) / 400);
  const yoe = yy - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

export function formsCivilFromDays(z0: number): readonly [number, number, number] {
  const z = z0 + 719468;
  const era = Math.floor((z >= 0 ? z : z - 146096) / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp + (mp < 10 ? 3 : -9);
  return [y + (m <= 2 ? 1 : 0), m, d];
}

/** The day count of an ISO civil date, or null when the date does not exist. */
export function formsDayNumber(iso: string): number | null {
  const s = iso ?? "";
  if (s.length < 10) return null;
  if (s[4] !== "-" || s[7] !== "-") return null;
  for (const i of [0, 1, 2, 3, 5, 6, 8, 9]) if (!isDigit(s[i] ?? "")) return null;
  const y = Number(s.slice(0, 4)), m = Number(s.slice(5, 7)), d = Number(s.slice(8, 10));
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const n = formsDaysFromCivil(y, m, d);
  const [ry, rm, rd] = formsCivilFromDays(n);
  return ry === y && rm === m && rd === d ? n : null;
}

function pad(n: number, width: number): string {
  let s = String(Math.abs(n));
  while (s.length < width) s = `0${s}`;
  return n < 0 ? `-${s}` : s;
}

export function formsDateFromDay(day: number): string {
  const [y, m, d] = formsCivilFromDays(day);
  return `${pad(y, 4)}-${pad(m, 2)}-${pad(d, 2)}`;
}

/** ISO weekday, 1 = Monday … 7 = Sunday. Day 0 (1970-01-01) was a Thursday. */
export function formsWeekday(day: number): number { return ((day % 7) + 7 + 3) % 7 + 1; }

export type MonthGrid = Readonly<{ days: number; leading: number; weeks: number }>;

/** The calendar grid geometry. `firstWeekday` is ISO (1 = Monday … 7 = Sunday). */
export function formsMonthGrid(year: number, month: number, firstWeekday: number): MonthGrid {
  const first = formsDaysFromCivil(year, month, 1);
  const next = formsDaysFromCivil(month === 12 ? year + 1 : year, month === 12 ? 1 : month + 1, 1);
  const days = next - first;
  const leading = ((formsWeekday(first) - firstWeekday) % 7 + 7) % 7;
  return { days, leading, weeks: Math.ceil((leading + days) / 7) };
}

export type DateFoldConfig = Readonly<{
  range?: boolean;
  min?: string | null;
  max?: string | null;
  disabledDates?: readonly string[];
  start?: string | null;
  end?: string | null;
  month?: string;
}>;

export type DateFoldEvent =
  | Readonly<{ kind: "select"; date: string }>
  | Readonly<{ kind: "month"; month: string }>
  | Readonly<{ kind: "clear" }>;

export type DateFoldStep = Readonly<{
  start: string | null; end: string | null; month: string;
  complete: boolean; reason: string; fired: readonly string[];
}>;

export type Selectability = Readonly<{ ok: boolean; reason: string }>;

export function formsSelectable(config: DateFoldConfig, iso: string): Selectability {
  const n = formsDayNumber(iso);
  if (n === null) return { ok: false, reason: "malformed" };
  const lo = formsDayNumber(config.min ?? "");
  const hi = formsDayNumber(config.max ?? "");
  if (lo !== null && n < lo) return { ok: false, reason: "before-min" };
  if (hi !== null && n > hi) return { ok: false, reason: "after-max" };
  if ((config.disabledDates ?? []).includes(iso)) return { ok: false, reason: "disabled" };
  return { ok: true, reason: "" };
}

/** THE RANGE FOLD. A select before an open start RESTARTS the range (never a silent
 *  swap); a close whose span contains a disabled date is refused WHOLE. */
export function formsDateFold(config: DateFoldConfig, events: readonly DateFoldEvent[]): DateFoldStep[] {
  const range = config.range === true;
  const disabled = config.disabledDates ?? [];
  let start: string | null = config.start ?? null;
  let end: string | null = config.end ?? null;
  let month = config.month ?? "";
  const steps: DateFoldStep[] = [];
  for (const ev of events) {
    let reason = "";
    let fired: string[] = [];
    if (ev.kind === "select") {
      const sel = formsSelectable(config, ev.date);
      if (!sel.ok) {
        reason = sel.reason;
      } else if (!range) {
        start = ev.date; end = ev.date;
      } else if (start === null || end !== null) {
        start = ev.date; end = null;
      } else if ((formsDayNumber(ev.date) ?? 0) < (formsDayNumber(start) ?? 0)) {
        start = ev.date; end = null;
      } else {
        const from = formsDayNumber(start) ?? 0;
        const to = formsDayNumber(ev.date) ?? 0;
        let blocked = false;
        for (let d = from; d <= to; d += 1) if (disabled.includes(formsDateFromDay(d))) { blocked = true; break; }
        if (blocked) reason = "range-contains-disabled";
        else end = ev.date;
      }
    } else if (ev.kind === "month") {
      if (ev.month !== month) { month = ev.month; fired = ["month"]; }
    } else {
      start = null; end = null;
    }
    steps.push({
      start, end, month,
      complete: range ? start !== null && end !== null : start !== null,
      reason, fired,
    });
  }
  return steps;
}

// ─────────────────────────────────────────────────────────────────────────────
// VALIDITY
// ─────────────────────────────────────────────────────────────────────────────

const EMAIL_RE = /^[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}$/i;
const PHONE_RE = /^[+]?[0-9 ()\-]{7,}$/;
/** The PORTABLE twin of the JSE `url()` rule (which uses the URL constructor); the two
 *  agree on every corpus case, and this one is expressible on all three runtimes. */
const URL_RE = /^[A-Za-z][A-Za-z0-9+.\-]*:\/\/[^\s/?#]+\S*$/;

/** `required` is the ONLY rule an empty value can fail. */
export function formsRule(name: string, arg: string, value: string, pattern: string): boolean {
  const v = value ?? "";
  if (name === "required") return v.trim() !== "";
  if (v === "") return true;
  switch (name) {
    case "email": return EMAIL_RE.test(v);
    case "phone": return PHONE_RE.test(v);
    case "url": return URL_RE.test(v);
    case "minLength": return v.length >= (Number(arg) || 0);
    case "maxLength": return v.length <= (Number(arg) || 0);
    case "pattern":
    case "regex": {
      const p = arg !== "" ? arg : pattern;
      if (p === "") return true;
      try { return new RegExp(p).test(v); } catch { return false; }
    }
    default: return true;
  }
}

export type FormFieldState = Readonly<{
  name: string; value?: string; initial?: string;
  validate?: string; pattern?: string; message?: string;
}>;

const RULE_MESSAGES: Readonly<Record<string, string>> = {
  required: "Required",
  email: "Enter a valid email",
  url: "Enter a valid URL",
  phone: "Enter a valid phone number",
  pattern: "Invalid format",
  regex: "Invalid format",
};

/** The FIRST failing rule owns the message; `message=` overrides it. */
export function formsFieldError(field: FormFieldState): string {
  const specs = (field.validate ?? "").split(",").map((r) => r.trim()).filter((r) => r !== "");
  for (const spec of specs) {
    const colon = spec.indexOf(":");
    const name = colon < 0 ? spec : spec.slice(0, colon);
    const arg = colon < 0 ? "" : spec.slice(colon + 1);
    if (formsRule(name, arg, field.value ?? "", field.pattern ?? "")) continue;
    if ((field.message ?? "") !== "") return field.message!;
    if (name === "minLength") return `Must be at least ${arg} characters`;
    if (name === "maxLength") return `Must be at most ${arg} characters`;
    return RULE_MESSAGES[name] ?? "Invalid";
  }
  return "";
}

export type FormAggregate = Readonly<{
  valid: boolean; dirty: boolean;
  errors: Readonly<Record<string, string>>;
  /** The `on:invalid` payload: the offending names in REGISTRATION order. */
  invalid: readonly string[];
}>;

export function formsAggregate(fields: readonly FormFieldState[]): FormAggregate {
  const errors: Record<string, string> = {};
  const invalid: string[] = [];
  let dirty = false;
  for (const f of fields) {
    const e = formsFieldError(f);
    errors[f.name] = e;
    if (e !== "") invalid.push(f.name);
    if ((f.value ?? "") !== (f.initial ?? "")) dirty = true;
  }
  return { valid: invalid.length === 0, dirty, errors, invalid };
}

export type SubmitState = Readonly<{ submitting?: boolean; disabled?: boolean }>;

export type SubmitOutcome = Readonly<{
  action: "submit" | "invalid" | "blocked";
  reason: string;
  fields?: readonly string[];
  submitting?: boolean;
  submitted?: boolean;
  touchedAll?: boolean;
  disabled: boolean;
}>;

/** THE DOUBLE-SUBMIT LAW: a submit already in flight, or a disabled form, runs nothing. */
export function formsSubmit(state: SubmitState, fields: readonly FormFieldState[]): SubmitOutcome {
  const disabled = state.disabled === true;
  if (disabled) return { action: "blocked", reason: "disabled", disabled: true, submitting: state.submitting === true };
  if (state.submitting === true) return { action: "blocked", reason: "in-flight", disabled: false, submitting: true };
  const agg = formsAggregate(fields);
  if (!agg.valid) {
    return { action: "invalid", reason: "", fields: agg.invalid, submitting: false,
             submitted: true, touchedAll: true, disabled: false };
  }
  return { action: "submit", reason: "", fields: [], submitting: true,
           submitted: true, touchedAll: false, disabled: false };
}

// ─────────────────────────────────────────────────────────────────────────────
// <multiselect> / <tagsfield>
// ─────────────────────────────────────────────────────────────────────────────

export type MultiSelectResult = Readonly<{
  selected: readonly string[]; changed: boolean; reason: string;
}>;

/** Insertion-ordered. Adding at `max` is REFUSED, never a silent eviction. */
export function multiSelectToggle(
  selected: readonly string[], value: string, max: number,
): MultiSelectResult {
  if (selected.includes(value)) {
    return { selected: selected.filter((v) => v !== value), changed: true, reason: "" };
  }
  if (max > 0 && selected.length >= max) {
    return { selected: [...selected], changed: false, reason: "max-reached" };
  }
  return { selected: [...selected, value], changed: true, reason: "" };
}

/** A11Y: `<multiselect>` announces the running selection COUNT. */
export function multiSelectAnnouncement(count: number, max: number): string {
  if (count === 0) return "None selected";
  const noun = count === 1 ? "item" : "items";
  return max > 0 ? `${count} of ${max} ${noun} selected` : `${count} ${noun} selected`;
}

export type TagsConfig = Readonly<{ separator?: string; max?: number; validate?: string }>;

export type TagRejection = Readonly<{ tag: string; reason: string }>;

export type TagsResult = Readonly<{
  tags: readonly string[]; added: readonly string[]; rejected: readonly TagRejection[];
}>;

/** Split on every character of `separator`, trim, drop empties, refuse duplicates,
 *  pattern failures and anything past `max` — the refusals are RETURNED so `on:add`
 *  can report them, never swallowed. */
export function tagsAdd(tags: readonly string[], text: string, config: TagsConfig): TagsResult {
  const seps = config.separator !== undefined && config.separator !== "" ? config.separator : ",";
  const out = [...tags];
  const added: string[] = [];
  const rejected: TagRejection[] = [];
  const parts: string[] = [];
  let buf = "";
  for (const ch of text) {
    if (seps.includes(ch)) { parts.push(buf); buf = ""; } else buf += ch;
  }
  parts.push(buf);
  const max = config.max ?? 0;
  let re: RegExp | null = null;
  if ((config.validate ?? "") !== "") { try { re = new RegExp(config.validate!); } catch { re = null; } }
  for (const part of parts) {
    const t = part.trim();
    if (t === "") continue;
    if (out.includes(t)) { rejected.push({ tag: t, reason: "duplicate" }); continue; }
    if (max > 0 && out.length >= max) { rejected.push({ tag: t, reason: "max-reached" }); continue; }
    if ((config.validate ?? "") !== "" && (re === null || !re.test(t))) {
      rejected.push({ tag: t, reason: "invalid" }); continue;
    }
    out.push(t);
    added.push(t);
  }
  return { tags: out, added, rejected };
}

export type TagsBackspace = Readonly<{ tags: readonly string[]; removed: string | null }>;

/** Backspace on an EMPTY query removes the last chip — the interaction everyone expects
 *  and nobody implements. With text in the query it removes nothing. */
export function tagsBackspace(tags: readonly string[], query: string): TagsBackspace {
  if (query !== "" || tags.length === 0) return { tags: [...tags], removed: null };
  return { tags: tags.slice(0, -1), removed: tags[tags.length - 1]! };
}

/** A11Y: `<tagsfield>` announces every add and every remove with the running count. */
export function tagsAnnouncement(kind: "add" | "remove", tag: string, count: number): string {
  return `${tag} ${kind === "add" ? "added" : "removed"}, ${count} ${count === 1 ? "tag" : "tags"}`;
}
